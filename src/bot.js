const TelegramBot = require('node-telegram-bot-api');
const Config = require('../config/config.js')
const execSync = require('child_process').execSync;
const fs = require('fs');

// try to read the DB so it fails quick if an error occurs
fs.readFileSync(Config.DBPath);

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(Config.TelegramToken, {polling: true});

// handle /start messages - display a message and move on
function start(msg) {
    const chatId = msg.chat.id;

    bot.sendMessage(chatId, `Welcome to the free plasma telegram bot,
powered by alien-valley.io pillar.
If you want to support the pillar,
just delegate to it.
All funds will be used to invest in Research
which will benefit the network.
     
To receive free plasma,
just send a message with the desired address
and 50 QSR will be fused to that address.

This can be done one per telegram account.`);
}

bot.on('message', (msg) => {
    if (msg.text === '/start') {
        return start(msg);
    }

    const chatId = msg.chat.id;
    const userId = msg.from.id;

    let db = JSON.parse(fs.readFileSync(Config.DBPath).toString());

    if (userId in db) {
        bot.sendMessage(chatId, `Looks like you already fused for ${db[userId].msg.text}`);
        return;
    }

    try {
        const result = execSync(`znn_cli -k ${Config.KeyFile} -p ${Config.KeyFilePassword} -u ${Config.ZnndWsUrl} balance`);
        if (result.toString().match("  0.00000000 QSR zenon.network zts1qsrxxxxxxxxxxxxxmrhjll")) {
            bot.sendMessage(chatId, `Looks like the program ran out of QSR at the moment.`);
            return;
        }

        execSync(`znn_cli -k ${Config.KeyFile} -p ${Config.KeyFilePassword} -u ${Config.ZnndWsUrl} plasma.fuse ${msg.text} 50`);
    } catch(e) {
        bot.sendMessage(chatId, `Something bad happened. Maybe '${msg.text}' is not a valid address?`);
        return;
    }

    db[userId] = {
        msg: msg,
    }
    fs.writeFileSync(Config.DBPath, JSON.stringify(db))
    bot.sendMessage(chatId, `Fused 50 QSR for ${msg.text}`);
});