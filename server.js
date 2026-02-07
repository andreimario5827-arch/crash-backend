// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

// 1. Setup
const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 2. Game State
let gameState = {
    status: 'IDLE', // IDLE, RUNNING, CRASHED
    multiplier: 1.00,
    crashPoint: 0
};

// 3. The Game Loop (The Engine)
const startGame = () => {
    if (gameState.status === 'RUNNING') return;

    // Calculate Crash Point (Weighted random to crash early often, rare high spikes)
    // Simple algorithm: 0.99 / (1 - Math.random())
    gameState.crashPoint = Math.max(1.00, (0.99 / (1 - Math.random())));
    gameState.multiplier = 1.00;
    gameState.status = 'RUNNING';

    console.log(`🚀 New Round! Will crash at ${gameState.crashPoint.toFixed(2)}x`);
    io.emit('game_start', { startTime: Date.now() });

    // The "Tick" Loop
    let interval = setInterval(() => {
        // Exponential growth formula: e^(0.06 * time)
        gameState.multiplier += gameState.multiplier * 0.08;

        if (gameState.multiplier >= gameState.crashPoint) {
            clearInterval(interval);
            crashGame();
        } else {
            io.emit('tick', gameState.multiplier);
        }
    }, 100); // Update every 100ms
};

const crashGame = () => {
    gameState.status = 'CRASHED';
    io.emit('crash', gameState.multiplier);
    console.log(`💥 Crashed at ${gameState.multiplier.toFixed(2)}x`);

    // Wait 5 seconds then restart
    setTimeout(() => {
        gameState.status = 'IDLE';
        io.emit('game_idle');
        setTimeout(startGame, 3000); // 3s countdown
    }, 5000);
};

// Start the first loop
startGame();

// 4. Socket.io (Realtime Betting)
io.on('connection', (socket) => {
    socket.emit('init', gameState); // Send current state to new user

    // Handle "Place Bet"
    socket.on('place_bet', async({ userId, amount }) => {
        if (gameState.status !== 'IDLE') return; // Can only bet in IDLE

        // Check balance
        const { data: user } = await supabase.from('users').select('balance').eq('id', userId).single();
        if (!user || user.balance < amount) return socket.emit('error', 'Insufficient funds');

        // Deduct Balance
        await supabase.from('users').update({ balance: user.balance - amount }).eq('id', userId);
        socket.emit('bet_accepted', { amount });
    });

    // Handle "Cash Out"
    socket.on('cash_out', async({ userId, amount, multiplier }) => {
        if (gameState.status !== 'RUNNING') return;

        const profit = Math.floor(amount * multiplier);

        // Update DB
        await supabase.rpc('increment_balance', { user_id: userId, amount: profit });

        // Log the win
        await supabase.from('bets').insert({ user_id: userId, amount, cash_out_at: multiplier, profit });

        socket.emit('cash_out_success', { profit });
    });
});

// 5. Telegram Bot (Payments)
bot.command('start', (ctx) => ctx.reply('Welcome! Type /buy to get chips.'));

// Invoice for 50 Stars
bot.command('buy', (ctx) => {
    return ctx.replyWithInvoice({
        title: '1,000 Game Chips',
        description: 'Fuel for the rocket 🚀',
        payload: 'pack_1000',
        provider_token: "", // EMPTY for Telegram Stars
        currency: 'XTR',
        prices: [{ label: '1,000 Chips', amount: 50 }], // 50 Stars
    });
});

bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));

bot.on('successful_payment', async(ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username;

    // Upsert user (create if new) and add 1000 chips
    const { data: user } = await supabase.from('users').select('balance').eq('id', userId).single();
    const currentBalance = user ? user.balance : 0;

    await supabase.from('users').upsert({
        id: userId,
        username: username,
        balance: currentBalance + 1000
    });

    ctx.reply('Payment successful! 1,000 Chips added. 🎰');
});

// Start Server
bot.launch();
server.listen(3000, () => console.log('Server running on port 3000'));