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

let currentRoundBets = 0; // Memoreaza cati bani s-au pariat in runda curenta

const startGame = () => {
    gameState.status = 'BETTING';
    gameState.multiplier = 1.00; // MODIFICA IN 0.00 DACA VREI SA INCEAPA DE LA 0
    gameState.countdown = 5;
    currentRoundBets = 0; // Resetam pariurile la inceputul rundei
    // NOTA: pastreaza cashedOutThisRound.clear() daca il aveai in codul tau!
    if (typeof cashedOutThisRound !== 'undefined') cashedOutThisRound.clear();

    let countdownInterval = setInterval(() => {
        gameState.countdown--;
        // Folosim safeState() cum aveai tu in cod
        io.emit('game_state_update', typeof safeState === 'function' ? safeState() : gameState);

        if (gameState.countdown <= 0) {
            clearInterval(countdownInterval);
            runGame();
        }
    }, 1000);
};

const runGame = () => {
    gameState.status = 'RUNNING';

    // 1. ALGORITMUL DE BAZA
    let baseCrash = 0.99 / (1 - Math.random());

    // 2. ALGORITMUL INTELIGENT (Invata din pariuri)
    console.log(`🤖 Pariuri totale in runda asta: ${currentRoundBets} cipuri.`);

    if (currentRoundBets > 5000) {
        console.log("⚠️ Risc mare pentru Casa! Reducem zborul.");
        baseCrash = baseCrash * 0.4;
    } else if (currentRoundBets > 1000) {
        baseCrash = baseCrash * 0.8;
    } else if (currentRoundBets < 100) {
        console.log("🎣 Pariuri mici. Lasam racheta sa zboare sus!");
        baseCrash = baseCrash * 1.5;
    }

    // Setam punctul de crash
    gameState.crashPoint = Math.max(1.00, baseCrash); // PUNE 0.00 IN LOC DE 1.00 DACA VREI SA INCEAPA DE LA 0

    io.emit('game_state_update', typeof safeState === 'function' ? safeState() : gameState);

    let ticks = 0;
    let flyInterval = setInterval(() => {
        ticks++;

        // 3. NOUA CURBA DE ZBOR (Lina la inceput, accelerata la final)
        const speedCurve = 0.002 + (ticks * 0.0005);
        gameState.multiplier += speedCurve;

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

        currentRoundBets += amount;

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

// --- COMANDA WITHDRAW (Retragere Manuala) ---
bot.command('withdraw', async(ctx) => {
    const parts = ctx.message.text.split(' ');

    if (parts.length < 3) {
        return ctx.reply("❌ Invalid format!\nType: /withdraw <AMOUNT> <TON_ADDRESS>\nExample: /withdraw 1000 UQDeRtg...");
    }

    const amount = parseInt(parts[1]);
    const address = parts[2];
    const userId = ctx.from.id;
    const username = ctx.from.username || 'Anonymous';

    if (isNaN(amount) || amount < 100) {
        return ctx.reply("❌ The minimum withdrawal amount is 100 chips.");
    }

    const { data: user } = await supabase.from('users').select('balance').eq('id', userId).single();

    if (!user || user.balance < amount) {
        return ctx.reply(`❌ Not enough chips! You only have ${user?.balance || 0}.`);
    }

    const { error } = await supabase.from('users').update({ balance: user.balance - amount }).eq('id', userId);

    if (error) {
        return ctx.reply("❌ Technical error. Please try again later.");
    }

    const alertMessage = `
🚨 <b>NEW WITHDRAWAL REQUEST!</b> 🚨

👤 <b>User:</b> @${username} (ID: <code>${userId}</code>)
💰 <b>Amount:</b> ${amount} Chips
🏦 <b>TON Address:</b> <code>${address}</code>

⚠️ <i>Verify if they played fairly and send the funds manually from your Wallet!</i>
`;

    try {
        await bot.telegram.sendMessage(ADMIN_ID, alertMessage, { parse_mode: 'HTML' });
        ctx.reply("✅ Request sent successfully!\n⏳ An administrator will process your payment soon.");
    } catch (err) {
        console.log("Error sending admin alert:", err);
        ctx.reply("✅ Request registered.");
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

        // 5. CONFIRMARE CATRE UTILIZATOR
        await ctx.reply(`✅ PAYMENT SUCCESSFUL! 🌟\n\nYou received ${chipsToAdd} Chips.\nYour new balance is: ${newBalance} 🪙`);

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
    return ctx.reply('Ready for launch? 🚀\n\nPlay now and win chips!', {
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