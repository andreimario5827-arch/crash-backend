require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

// --- CONFIGURARE ADMIN ---
// ⚠️ INLOCUIESTE '00000000' CU ID-UL TAU DE TELEGRAM (de la @userinfobot)
const ADMIN_ID = 5418546828;
// -------------------------

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Game State
let gameState = {
    status: 'BETTING',
    multiplier: 1.00,
    crashPoint: 0,
    countdown: 5
};

// The Game Loop
const startGame = () => {
    gameState.status = 'BETTING';
    gameState.multiplier = 1.00;
    gameState.countdown = 5;

    let countdownInterval = setInterval(() => {
        gameState.countdown--;
        io.emit('game_state_update', gameState);

        if (gameState.countdown <= 0) {
            clearInterval(countdownInterval);
            runGame();
        }
    }, 1000);
};

const runGame = () => {
    gameState.status = 'RUNNING';
    // Crash algorithm
    gameState.crashPoint = Math.max(1.00, (0.99 / (1 - Math.random())));

    console.log(`🚀 Launching! Target: ${gameState.crashPoint.toFixed(2)}x`);
    io.emit('game_state_update', gameState);

    let flyInterval = setInterval(() => {
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
    setTimeout(() => startGame(), 3000);
};

startGame();

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    socket.emit('game_state_update', gameState);

    socket.on('place_bet', async({ userId, amount }) => {
        if (gameState.status !== 'BETTING') return;
        const { data: user } = await supabase.from('users').select('balance').eq('id', userId).single();
        if (!user || user.balance < amount) return;

        await supabase.from('users').update({ balance: user.balance - amount }).eq('id', userId);
        socket.emit('bet_accepted', { amount });
    });

    socket.on('cash_out', async({ userId, amount, multiplier }) => {
        if (gameState.status !== 'RUNNING') return;
        const profit = Math.floor(amount * multiplier);
        const { data: user } = await supabase.from('users').select('balance').eq('id', userId).single();
        await supabase.from('users').update({ balance: user.balance + profit }).eq('id', userId);
        socket.emit('cash_out_success', { profit });
    });
});

// --- SISTEM DE RETRAGERE (NOU) ---
bot.command('withdraw', async(ctx) => {
    const parts = ctx.message.text.split(' ');
    // Format: /withdraw 1000 ADRESA_TON

    if (parts.length < 3) {
        return ctx.reply("❌ Format gresit!\nScrie: /withdraw <SUMA> <ADRESA_TON>\nExemplu: /withdraw 1000 UQDeRtg...");
    }

    const amount = parseInt(parts[1]);
    const address = parts[2];
    const userId = ctx.from.id;
    const username = ctx.from.username || 'Anonim';

    if (isNaN(amount) || amount < 100) { // Minim 100 cipuri
        return ctx.reply("❌ Suma minima de retragere este 100 cipuri.");
    }

    // 1. Verificam Balanta
    const { data: user } = await supabase.from('users').select('balance').eq('id', userId).single();

    if (!user || user.balance < amount) {
        return ctx.reply(`❌ Nu ai suficiente cipuri! Ai doar ${user?.balance || 0}.`);
    }

    // 2. Scadem banii din baza de date
    const { error } = await supabase.from('users').update({ balance: user.balance - amount }).eq('id', userId);

    if (error) {
        return ctx.reply("❌ Eroare tehnica. Incearca mai tarziu.");
    }

    // 3. Trimitem alerta catre TINE (Admin)
    const alertMessage = `
🚨 <b>CERERE DE RETRAGERE NOUA!</b> 🚨

👤 <b>User:</b> @${username} (ID: <code>${userId}</code>)
💰 <b>Suma:</b> ${amount} Cipuri
🏦 <b>Adresa TON:</b> <code>${address}</code>

⚠️ <i>Verifica daca a jucat corect si trimite-i banii manual din Wallet!</i>
`;

    try {
        // Aici botul iti scrie TIE privat
        await bot.telegram.sendMessage(ADMIN_ID, alertMessage, { parse_mode: 'HTML' });
        ctx.reply("✅ Cererea a fost trimisa cu succes!\n⏳ Administratorul va procesa plata in curand.");
    } catch (err) {
        console.log("Eroare la trimiterea mesajului catre admin:", err);
        ctx.reply("✅ Cererea inregistrata (Adminul va verifica manual).");
    }
});

// --- TELEGRAM STARS (Plati Oficiale) ---
bot.command('buy', (ctx) => {
    return ctx.replyWithInvoice({
        title: '1,000 Moon Chips',
        description: 'Fuel for your rocket 🚀',
        payload: 'packet_1000',
        provider_token: "", // GOL pentru Stars
        currency: 'XTR', // Moneda Stars
        prices: [{ label: '1,000 Chips', amount: 50 }], // 50 Stars
    });
});

bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));

bot.on('successful_payment', async(ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username || 'Anon';
    const amountPaid = ctx.message.successful_payment.total_amount;

    // 50 Stars = 1000 Chips
    const chipsToAdd = (amountPaid === 50) ? 1000 : 100;

    const { data: user } = await supabase.from('users').select('balance').eq('id', userId).single();
    const currentBalance = user ? user.balance : 0;

    await supabase.from('users').upsert({
        id: userId,
        username: username,
        balance: currentBalance + chipsToAdd
    });

    ctx.reply(`PLATA REUSITA! 🌟\nAm adaugat ${chipsToAdd} Cipuri in contul tau.`);
});
// --- COMANDA DE START JOC ---
bot.command('play', (ctx) => {
    return ctx.reply('Ești gata de lansare? 🚀\n\nJoacă acum și câștigă cipuri!', {
        reply_markup: {
            inline_keyboard: [
                [
                    // Folosim "url" pentru link-ul t.me
                    { text: "🎮 PLAY NOW", url: "https://t.me/MoversCrash_bot/play" }
                ]
            ]
        }
    });
});
bot.launch();
server.listen(3000, () => console.log('Server running on 3000'));