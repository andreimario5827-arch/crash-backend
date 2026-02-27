require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const crypto = require('crypto');

// =============================================================================
// CONFIG
// =============================================================================
const ADMIN_ID = 5418546828; // Your Telegram ID

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Normalise Telegram user IDs to a JavaScript number to match your Supabase int8 column.
 * Passing a string to .eq() against an int8 column silently returns zero rows —
 * the #1 reason chips were never delivered after payment.
 */
const toUserId = (id) => Number(id);

/**
 * Fetch a user's current balance. Returns 0 for brand-new users (no row yet).
 * Throws on real DB errors.
 */
const getBalance = async(userId) => {
    const { data, error } = await supabase
        .from('users')
        .select('balance')
        .eq('id', toUserId(userId))
        .single();

    // PGRST116 = "no rows returned" — totally normal for a new user
    if (error && error.code !== 'PGRST116') throw error;
    return data ? data.balance : 0;
};

/**
 * Set a user's balance (upsert — creates the row if it doesn't exist yet).
 * Always uses onConflict:'id' so Supabase knows to UPDATE, not INSERT a duplicate.
 */
const setBalance = async(userId, newBalance, username = 'Anonim') => {
    const { error } = await supabase
        .from('users')
        .upsert({ id: toUserId(userId), username, balance: newBalance }, { onConflict: 'id' });
    if (error) throw error;
};

/**
 * Silently send a message to the admin. Never throws — used inside catch blocks
 * where we can't afford another failure.
 */
const alertAdmin = async(message) => {
    try {
        await bot.telegram.sendMessage(ADMIN_ID, message, { parse_mode: 'HTML' });
    } catch (err) {
        console.error('Could not reach admin:', err.message);
    }
};

// =============================================================================
// AUTHENTICATION
// =============================================================================

// In-memory token store: token -> { userId, username }
// Fine for a single server. For multi-server / restarts, move to Redis or Supabase.
const authTokens = new Map();

// Called by your Telegram Mini App right after the user opens it.
// The front-end passes the Telegram userId + username, gets back a session token,
// then sends that token on every socket event.
app.post('/auth', (req, res) => {
    const { userId, username } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const token = crypto.randomBytes(32).toString('hex');
    authTokens.set(token, {
        userId: toUserId(userId),
        username: username || 'Anonim',
    });

    // Auto-expire after 24 hours
    setTimeout(() => authTokens.delete(token), 24 * 60 * 60 * 1000);

    res.json({ token });
});

// =============================================================================
// GAME STATE
// =============================================================================

let gameState = {
    status: 'BETTING',
    multiplier: 1.00,
    crashPoint: 0, // NEVER sent to clients
    countdown: 5,
};

// Which users have already cashed out in the current round
const cashedOutThisRound = new Set();

// Only these fields go to the client — crashPoint stays server-side
const safeState = () => ({
    status: gameState.status,
    multiplier: gameState.multiplier,
    countdown: gameState.countdown,
});

// =============================================================================
// GAME LOOP
// =============================================================================

const startGame = () => {
    gameState.status = 'BETTING';
    gameState.multiplier = 1.00;
    gameState.countdown = 5;
    cashedOutThisRound.clear();

    const countdownInterval = setInterval(() => {
        gameState.countdown--;
        io.emit('game_state_update', safeState());

        if (gameState.countdown <= 0) {
            clearInterval(countdownInterval);
            runGame();
        }
    }, 1000);
};

const runGame = () => {
    gameState.status = 'RUNNING';
    gameState.crashPoint = Math.max(1.00, 0.99 / (1 - Math.random()));

    console.log(`🚀 Launching! Target: ${gameState.crashPoint.toFixed(2)}x`);
    io.emit('game_state_update', safeState());

    const flyInterval = setInterval(() => {
        gameState.multiplier += gameState.multiplier * 0.08;

        if (gameState.multiplier >= gameState.crashPoint) {
            clearInterval(flyInterval);
            crashGame();
        } else {
            io.emit('tick', gameState.multiplier);
        }
    }, 100);
};

const crashGame = () => {
    gameState.status = 'CRASHED';
    io.emit('crash', gameState.multiplier);
    setTimeout(startGame, 3000);
};

startGame();

// =============================================================================
// SOCKET.IO
// =============================================================================

io.on('connection', (socket) => {
    socket.emit('game_state_update', safeState());

    // --- COD NOU: Trimite balanta cand o cere frontend-ul ---
    socket.on('request_balance', async(userId) => {
        console.log(`📡 Frontend a cerut balanta pentru ID: ${userId}`);

        const { data: user, error } = await supabase.from('users').select('balance').eq('id', userId).single();

        if (error) console.log("❌ Eroare cautare user:", error.message);

        if (user) {
            console.log(`✅ User gasit! Trimitem balanta: ${user.balance}`);
            socket.emit('balance_update', user.balance);
        } else {
            console.log(`⚠️ User negasit. Trimitem 0.`);
            socket.emit('balance_update', 0);
        }
    });
    // ---------------------------------------------------------

    // --- AUTHENTICATE ---
    // Front-end must call this first with the token from POST /auth
    socket.on('authenticate', ({ token }) => {
        const session = authTokens.get(token);
        if (!session) {
            socket.emit('auth_error', { message: 'Invalid or expired token. Please re-login.' });
            return;
        }
        socket.userId = session.userId;
        socket.username = session.username;
        socket.emit('authenticated', { userId: socket.userId });
    });

    // --- PLACE BET ---
    socket.on('place_bet', async({ userId, amount }) => {
        console.log(`🎰 Pariu cerut: ID ${userId} | Suma: ${amount} | Status Joc: ${gameState.status}`);

        if (gameState.status !== 'BETTING') {
            console.log("❌ Pariu respins: Jocul nu e in faza de pariere.");
            return;
        }

        const { data: user, error: fetchError } = await supabase.from('users').select('balance').eq('id', userId).single();

        if (fetchError || !user) {
            console.log("❌ Pariu respins: Userul nu a fost gasit in baza de date.", fetchError);
            return;
        }

        if (user.balance < amount) {
            console.log(`❌ Pariu respins: Balanta insuficienta (${user.balance} < ${amount}).`);
            return;
        }

        // Scadem banii din baza de date
        const { error: updateError } = await supabase.from('users').update({ balance: user.balance - amount }).eq('id', userId);

        if (updateError) {
            console.log("❌ Eroare la actualizarea bazei de date:", updateError);
            return;
        }

        console.log(`✅ Pariu ACCEPTAT pentru ${userId}!`);
        socket.emit('bet_accepted', { amount });
    });

    // --- CASH OUT ---
    socket.on('cash_out', async({ userId, amount, multiplier }) => {
        console.log(`💸 Cash Out cerut: ID ${userId} | Pariu: ${amount} | Multiplicator: ${multiplier}`);

        if (gameState.status !== 'RUNNING') {
            console.log("❌ Cash Out respins: Racheta a explodat deja sau jocul nu ruleaza.");
            return;
        }

        // Calculam profitul (ex: 10 * 2.50 = 25)
        const profit = Math.floor(amount * multiplier);

        const { data: user, error: fetchError } = await supabase.from('users').select('balance').eq('id', userId).single();

        if (fetchError || !user) {
            console.log("❌ Cash Out respins: Userul nu a fost gasit in baza de date.", fetchError);
            return;
        }

        // Adaugam profitul la balanta utilizatorului
        const { error: updateError } = await supabase.from('users').update({ balance: user.balance + profit }).eq('id', userId);

        if (updateError) {
            console.log("❌ Eroare Cash Out la salvarea in baza de date:", updateError);
            return;
        }

        console.log(`✅ Cash Out REUSIT pentru ${userId}! A castigat +${profit} cipuri.`);
        // Trimitem confirmarea catre telefon ca sa ascunda butonul verde
        socket.emit('cash_out_success', { profit });
    });
});

// =============================================================================
// TELEGRAM BOT — WITHDRAW
// =============================================================================

bot.command('withdraw', async(ctx) => {
    const parts = ctx.message.text.split(' ');

    if (parts.length < 3) {
        return ctx.reply(
            '❌ Format gresit!\nScrie: /withdraw <SUMA> <ADRESA_TON>\nExemplu: /withdraw 1000 UQDeRtg...'
        );
    }

    const amount = parseInt(parts[1], 10);
    const address = parts[2];
    const userId = toUserId(ctx.from.id); // always string
    const username = ctx.from.username || 'Anonim';

    if (isNaN(amount) || amount < 100) {
        return ctx.reply('❌ Suma minima de retragere este 100 cipuri.');
    }

    try {
        const balance = await getBalance(userId);

        if (balance < amount) {
            return ctx.reply(`❌ Nu ai suficiente cipuri! Ai doar ${balance}.`);
        }

        const alertMessage = [
            '🚨 <b>CERERE DE RETRAGERE NOUA!</b> 🚨',
            '',
            `👤 <b>User:</b> @${username} (ID: <code>${userId}</code>)`,
            `💰 <b>Suma:</b> ${amount} Cipuri`,
            `🏦 <b>Adresa TON:</b> <code>${address}</code>`,
            '',
            '⚠️ <i>Verifica daca a jucat corect si trimite-i banii manual din Wallet!</i>',
        ].join('\n');

        // Send admin alert FIRST — only deduct if alert succeeds.
        // If the alert fails, user keeps their chips and can try again.
        await bot.telegram.sendMessage(ADMIN_ID, alertMessage, { parse_mode: 'HTML' });

        // Alert succeeded — safe to deduct now
        await setBalance(userId, balance - amount, username);

        return ctx.reply('✅ Cererea a fost trimisa cu succes!\n⏳ Administratorul va procesa plata in curand.');

    } catch (err) {
        console.error('withdraw error:', err);
        return ctx.reply('❌ A aparut o eroare. Incearca mai tarziu. Cipurile tale sunt in siguranta.');
    }
});

// =============================================================================
// TELEGRAM BOT — BUY (Telegram Stars)
// =============================================================================

bot.command('buy', (ctx) => {
    return ctx.replyWithInvoice({
        title: '1,000 Moon Chips',
        description: 'Fuel for your rocket 🚀',
        payload: 'packet_1000',
        provider_token: '', // Empty string = Telegram Stars
        currency: 'XTR',
        prices: [{ label: '1,000 Chips', amount: 50 }], // 50 Stars
    });
});

// Required by Telegram — must answer true or the payment is cancelled
bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));

// =============================================================================
// TELEGRAM BOT — SUCCESSFUL PAYMENT (chip delivery)
// =============================================================================

bot.on('successful_payment', async(ctx) => {
    try {
        console.log('💰 PLATA PRIMITA:', ctx.message.successful_payment);

        // toUserId() ensures the string type matches the Supabase 'id' column.
        // Without this, .eq() silently finds zero rows and chips are never added.
        const userId = toUserId(ctx.from.id);
        const username = ctx.from.username || 'Anonim';
        const { total_amount, currency } = ctx.message.successful_payment;

        console.log(`👤 User: ${userId} (${username}) | Paid: ${total_amount} ${currency}`);

        const chipsToAdd = 1000;

        // Read current balance (returns 0 if user is new — no row in DB yet)
        const currentBalance = await getBalance(userId);
        const newBalance = currentBalance + chipsToAdd;

        console.log(`🔄 Balance: ${currentBalance} → ${newBalance}`);

        // Write new balance.
        // setBalance uses upsert + onConflict:'id' so it always updates correctly.
        await setBalance(userId, newBalance, username);

        console.log(`✅ SUCCESS: ${chipsToAdd} chips added for ${userId}. New balance: ${newBalance}`);

        await ctx.reply(
            `✅ PLATA REUSITA! 🌟\n\n` +
            `Ai primit ${chipsToAdd} Cipuri 🪙\n` +
            `Balanța ta nouă: ${newBalance} 🪙\n\n` +
            `Apasă /play ca să începi!`
        );

    } catch (err) {
        // Top-level catch — always notify both the admin and the user
        console.error('❌ EROARE in successful_payment:', err);

        await alertAdmin(
            `🚨 <b>EROARE LA PROCESAREA PLATII!</b>\n` +
            `User: @${ctx.from?.username || '?'} (ID: <code>${ctx.from?.id}</code>)\n` +
            `Chips de adaugat manual: 1000\n` +
            `Eroare: ${err.message}`
        );

        try {
            await ctx.reply(
                '⚠️ Plata ta a fost primita de Telegram, dar a aparut o eroare la salvare.\n' +
                'Adminul a fost notificat si va adauga cipurile manual. Ne cerem scuze!'
            );
        } catch (_) {
            // ctx.reply itself failed — nothing more we can do
        }
    }
});

// =============================================================================
// TELEGRAM BOT — PLAY
// =============================================================================

bot.command('play', (ctx) => {
    return ctx.reply('Ești gata de lansare? 🚀\n\nJoacă acum și câștigă cipuri!', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🎮 PLAY NOW', url: 'https://t.me/MoversCrash_bot/play' }],
            ],
        },
    });
});

// =============================================================================
// START
// =============================================================================

bot.launch();
server.listen(3000, () => console.log('🟢 Server running on port 3000'));