require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Game State
let gameState = {
    status: 'BETTING', // New starting state
    multiplier: 1.00,
    crashPoint: 0,
    countdown: 5 // 5 seconds to bet
};

// The Game Loop
const startGame = () => {
    // 1. BETTING PHASE (5 Seconds)
    gameState.status = 'BETTING';
    gameState.multiplier = 1.00;
    gameState.countdown = 5;

    let countdownInterval = setInterval(() => {
        gameState.countdown--;
        io.emit('game_state_update', gameState);

        if (gameState.countdown <= 0) {
            clearInterval(countdownInterval);
            runGame(); // Start the rocket
        }
    }, 1000);
};

const runGame = () => {
    // 2. RUNNING PHASE (Rocket Flies)
    gameState.status = 'RUNNING';
    // Crash algorithm: skewed random to crash early often, but sometimes fly high
    gameState.crashPoint = Math.max(1.00, (0.99 / (1 - Math.random())));

    console.log(`🚀 Launching! Target: ${gameState.crashPoint.toFixed(2)}x`);
    io.emit('game_state_update', gameState);

    let flyInterval = setInterval(() => {
        gameState.multiplier += gameState.multiplier * 0.08; // Speed of rocket

        if (gameState.multiplier >= gameState.crashPoint) {
            clearInterval(flyInterval);
            crashGame();
        } else {
            io.emit('tick', gameState.multiplier);
        }
    }, 100);
};

const crashGame = () => {
    // 3. CRASH PHASE (Explosion)
    gameState.status = 'CRASHED';
    io.emit('crash', gameState.multiplier);
    console.log(`💥 Crashed at ${gameState.multiplier.toFixed(2)}x`);

    // Wait 3 seconds then go back to betting
    setTimeout(() => {
        startGame();
    }, 3000);
};

// Start the loop
startGame();

// --- SOCKET.IO (Realtime Game) ---
io.on('connection', (socket) => {
    socket.emit('game_state_update', gameState); // Send current state to new user

    socket.on('place_bet', async({ userId, amount }) => {
        if (gameState.status !== 'BETTING') return; // Can only bet during countdown

        const { data: user } = await supabase.from('users').select('balance').eq('id', userId).single();
        if (!user || user.balance < amount) return;

        // Deduct Balance immediately
        await supabase.from('users').update({ balance: user.balance - amount }).eq('id', userId);
        socket.emit('bet_accepted', { amount });
    });

    socket.on('cash_out', async({ userId, amount, multiplier }) => {
        if (gameState.status !== 'RUNNING') return;
        const profit = Math.floor(amount * multiplier);

        // Add Winnings (RPC function recommended, but direct update for MVP is fine)
        const { data: user } = await supabase.from('users').select('balance').eq('id', userId).single();
        await supabase.from('users').update({ balance: user.balance + profit }).eq('id', userId);

        socket.emit('cash_out_success', { profit });
    });
});

// --- TELEGRAM PAYMENTS (Stars) ---
// 1. Trigger Invoice
bot.command('buy', (ctx) => sendInvoice(ctx));
// Also allow triggering via web app data if needed, but command is easiest for testing
function sendInvoice(ctx) {
    return ctx.replyWithInvoice({
        title: '1,000 Moon Chips',
        description: 'Fuel for your rocket 🚀',
        payload: 'packet_1000',
        provider_token: "", // EMPTY for Telegram Stars
        currency: 'XTR', // The code for Stars
        prices: [{ label: '1,000 Chips', amount: 50 }], // 50 Stars ($1.00 approx)
    });
}

// 2. Pre-Checkout (Must approve instantly)
bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));

// 3. Successful Payment (Give Chips)
bot.on('successful_payment', async(ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username || 'Anon';
    const amountPaid = ctx.message.successful_payment.total_amount; // 50 Stars

    // Logic: 50 Stars = 1000 Chips
    const chipsToAdd = (amountPaid === 50) ? 1000 : 100;

    const { data: user } = await supabase.from('users').select('balance').eq('id', userId).single();
    const currentBalance = user ? user.balance : 0;

    await supabase.from('users').upsert({
        id: userId,
        username: username,
        balance: currentBalance + chipsToAdd
    });

    ctx.reply(`PAYMENT RECEIVED! 🌟\nAdded ${chipsToAdd} Chips to your balance.`);
});

bot.launch();
server.listen(3000, () => console.log('Server running on 3000'));