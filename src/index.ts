import {getConfig} from "./config";
import {DB, DBFuseEntry, DBTelegramMessage, DBUser} from "./db";
import SyncTelegramBot from "./telegram_bot";
import TelegramBot from 'node-telegram-bot-api';

import {KeyStore, Zenon} from "znn-ts-sdk";
import {KeyPair} from "znn-ts-sdk/dist/lib/src/wallet/keypair";
import {Address} from "znn-ts-sdk/dist/lib/src/model/primitives/address";
import {FusionEntryList} from "znn-ts-sdk/dist/lib/src/model/embedded/plasma";
import {Hash} from "znn-ts-sdk/dist/lib/src/model/primitives/hash";

// @ts-ignore
import {version} from "../package.json"

let bot: SyncTelegramBot
let zenon: Zenon
let db: DB
let keyPair: KeyPair
let myAddress: Address

// 3 minutes of timeout
const timeout = 3 * 60 * 1000

// 10 hours
const fuseDuration = 10 * 60 * 60 * 1000

function formatTime(time: number): string {
  const sec_num = Math.floor(time / 1000);
  const hours = Math.floor(sec_num / 3600);
  const minutes = Math.floor((sec_num - (hours * 3600)) / 60);
  const seconds = sec_num - (hours * 3600) - (minutes * 60);

  let result = "";

  if (hours < 10) {
    result += "0";
  }
  result += hours.toString() + ":"

  if (minutes < 10) {
    result += "0";
  }
  result += minutes.toString() + ":"

  if (seconds < 10) {
    result += "0";
  }
  result += seconds.toString()

  return result
}

function formatAmount(amount: number): string {
  return (amount / 1e8).toFixed(1)
}

// update the status of all fuse entries
// if present in NoM list
//   pending -> active
// if not present in NoM list
//   pending + timeout -> invalid
//   active -> canceled
async function updateStatus() {
  const allEntries = await getAllFuseEntries()
  const knownIds = new Map<string, boolean>()
  const hasBeenSeen = new Map<string, boolean>()

  for (const entry of allEntries.list) {
    knownIds.set(entry.id.toString(), true)
    hasBeenSeen.set(entry.id.toString(), false)
  }

  db.users.forEach((user) => {
    user.entries.forEach((value) => {
      if (value.status === "pending") {
        if (knownIds.has(value.id)) {
          // mark as seen
          value.status = "active";
          bot.sendMessage(user.id, "Update: fuse entry has been activated")
        } else if (value.creationTime + timeout < new Date().getTime()) {
          value.status = "invalid";
          bot.sendMessage(user.id, "Update: fuse entry has been invalidated")
        }
      } else if (value.status === "active") {
        if (!knownIds.has(value.id)) {
          value.status = "canceled";
          bot.sendMessage(user.id, "Update: fuse entry has been canceled")
        }
      }

      // good scenarios where we expect to see a fuse entry
      if (value.status === "pending" || value.status === "active") {
        hasBeenSeen.set(value.id, true)
      }
    })
  })

  hasBeenSeen.forEach((status) => {
    if (!status) {
      // TODO: fuse entry that is not accounted for in the DB; maybe cancel it directly if possible?
    }
  })

  db.save()
}

// get a DBUser associated to the Telegram message
function getUser(msg: TelegramBot.Message): DBUser {
  const userId = msg.from!.id.toString()
  const user = db.users.get(userId)
  if (user) {
    return user
  } else {
    return db.newUser(userId)
  }
}

// due to pageSize limitations, an implementation which actually gets all of them
async function getAllFuseEntries(): Promise<FusionEntryList> {
  return zenon.embedded.plasma.getEntriesByAddress(myAddress, 0, 1024)
}

// handle /start command
async function start(msg: TelegramBot.Message, header = "") {
  return bot.sendMessage(msg.chat.id, `${header}Welcome to the free plasma telegram bot V${version},
powered by alien-valley.io pillar
and by YOU, the Zenon Community!

If you want to support the pillar, just delegate to it.
All funds will be used to invest in Research
which will benefit the network.

Usage:     
To receive free plasma, just send a message with the desired address
10 QSR will be fused to the provided address.
Each telegram account has a limit of 50 QSR.

Advanced usage:
/list - show all fuse entries
/fuse {address} {amount} - fuse to a specific {address} a specified {amount} of QSR
/{number} - cancel the fuse entry with that number
{address} - fuse 10 QSR to {address}
`);
}

// handle /list command
async function list(msg: TelegramBot.Message) {
  const user = getUser(msg)

  const usedBalance = user.usedBalance()
  let response = `Used ${formatAmount(usedBalance)}/${formatAmount(user.maxBalance)} QSR\n`;

  for (const entry of user.entries) {
    const lifeTime = new Date().getTime() - entry.creationTime;
    if (entry.status === "active" && lifeTime > fuseDuration) {
      response = response + `✅ /${entry.sequenceNumber} ${formatAmount(entry.amount)} QSR to ${entry.beneficiary}\n`
    } else if (entry.status === "active") {
      response = response + `✅ ${entry.sequenceNumber} ${formatAmount(entry.amount)} QSR to ${entry.beneficiary} [${formatTime(fuseDuration - lifeTime)}]\n`
    } else if (entry.status === "pending") {
      response = response + `⏳ ${entry.sequenceNumber} ${formatAmount(entry.amount)} QSR to ${entry.beneficiary} [pending]\n`
    }
  }

  for (const entry of user.entries) {
    if (entry.status === "invalid" || entry.status === "canceled") {
      response = response + `❌ ${entry.sequenceNumber} ${formatAmount(entry.amount)} QSR to ${entry.beneficiary} [canceled]\n`
    }
  }

  return bot.sendMessage(msg.chat.id, response);
}

// shared function
async function simpleFuse(msg: TelegramBot.Message, toAddress: Address, amount: number) {
  const user = getUser(msg)

  // apply QSR decimals
  amount *= 1e8

  // check if user has enough QSR balance to perform the fuse operation
  const usedBalance = user.usedBalance()
  const remaining = user.maxBalance - usedBalance
  if (amount > remaining) {
    return bot.sendMessage(msg.chat.id, `Not enough QSR available. Required ${formatAmount(amount)} but only have ${remaining} QSR available`)
  }

  // make the fuse transaction & broadcast it to the network
  const block = await zenon.embedded.plasma.fuse(toAddress, amount)
  const response = await zenon.send(block, keyPair)

  // add entry in DB as pending, since it's not confirmed in a momentum
  user.entries.push(DBFuseEntry.deserialize({
    sequenceNumber: user.newSequenceNumber(),
    beneficiary: toAddress.toString(),
    amount: amount,
    creationTime: new Date().getTime(),
    id: response.hash.toString(),
    status: "pending"
  }))
  db.save()

  return bot.sendMessage(msg.chat.id, "Fuse transaction send!")
}

// handle /fuse {address} {amount} command
async function fuse(msg: TelegramBot.Message) {
  const usage = "example: /fuse z1qzyzqtszv6fnw56rpnlq0npqt70tux0cl0yn5k 10"

  // parse input
  const splits = msg.text!.split(' ')
  let toAddress: Address
  let amount: number
  if (splits.length !== 3) {
    return bot.sendMessage(msg.chat.id, `Incorrect number of parameters. ${usage}`)
  }

  try {
    toAddress = Address.parse(splits[1])
    amount = parseInt(splits[2])
  } catch {
    return bot.sendMessage(msg.chat.id, `Invalid address. ${usage}`)
  }

  // check amount is valid
  if (amount < 10 || isNaN(amount)) {
    return bot.sendMessage(msg.chat.id, `Amount too small. Needs to be bigger than 10 QSR. ${usage}`)
  }

  return simpleFuse(msg, toAddress, amount)
}

// handle /{number} command
async function cancelFuse(msg: TelegramBot.Message) {
  const user = getUser(msg)

  const splits = msg.text!.split(' ')
  const number = parseInt(splits[0].substring(1))

  // find entry by the sequence number
  let targetEntry = null
  for (const entry of user.entries) {
    if (entry.sequenceNumber === number) {
      targetEntry = entry
    }
  }

  if (targetEntry == null) {
    return bot.sendMessage(msg.chat.id, `Can't find fuse entry with id ${number}`)
  }

  const block = await zenon.embedded.plasma.cancel(Hash.parse(targetEntry.id))
  await zenon.send(block, keyPair)

  return bot.sendMessage(msg.chat.id, "Fuse entry cancel requested")
}

async function handleMsg(msg: TelegramBot.Message): Promise<TelegramBot.Message> {
  if (msg.text === undefined) {
    return bot.sendMessage(msg.chat.id, "failed to handle message: message expired")
  }

  // record all messages in DB
  getUser(msg).messages.push(DBTelegramMessage.fromTelegramMessage(msg))

  const splits = msg.text!.split(' ')

  switch (splits[0]) {
    case '/start':
      return start(msg)
    case '/list':
      return list(msg)
    case '/fuse':
      return fuse(msg)
  }

  // handle /{number}
  if (splits[0][0] === "/") {
    const number = parseInt(splits[0].substring(1))
    if (!(isNaN(number) || number == 0)) {
      return cancelFuse(msg)
    }
  }

  // handle {address} for a 10 QSR fuse
  try {
    const toAddress = Address.parse(splits[0])
    return simpleFuse(msg, toAddress, 10)
  } catch (e) {
  }

  return start(msg, `Unknown command '${splits[0]}'\n\n`)
}

async function main() {
  const config = getConfig()

  // setup storage
  db = new DB(config.dbPath)
  db.load()

  zenon = Zenon.getSingleton();

  // set zenon WS connection
  await zenon.initialize(config.url, true)

  // set zenon keyPair
  const store = new KeyStore();
  store.fromMnemonic(config.mnemonic)
  keyPair = store.getKeyPair()
  myAddress = await keyPair.getAddress()

  bot = new SyncTelegramBot(config.telegramToken, handleMsg)

  // update the state of the DB every 10 seconds
  setInterval(updateStatus, 10000)

  // never resolve promise. Do not exit
  await new Promise(() => {
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
