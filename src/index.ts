import {getConfig} from "./config";
import {DB, DBFuseEntry, DBTelegramMessage, DBUser} from "./db";
import {KeyStore, Zenon} from "znn-ts-sdk";
import TelegramBot from 'node-telegram-bot-api';
import {KeyPair} from "znn-ts-sdk/dist/lib/src/wallet/keypair";
import {Address} from "znn-ts-sdk/dist/lib/src/model/primitives/address";
import {FusionEntryList} from "znn-ts-sdk/dist/lib/src/model/embedded/plasma";
import {Hash} from "znn-ts-sdk/dist/lib/src/model/primitives/hash";

let bot: TelegramBot
let zenon: Zenon
let db: DB
let keyPair: KeyPair
let myAddress: Address

// 3 minutes of timeout
const timeout = 3 * 60 * 1000

function formatAmount(amount: number): string {
  return (amount / 1e8).toPrecision(2)
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
async function start(msg: TelegramBot.Message) {
  return bot.sendMessage(msg.chat.id, `Usage
/list
/fuse {address} {amount}`);
}

// handle /list command
async function list(msg: TelegramBot.Message) {
  const user = getUser(msg)

  const usedBalance = user.usedBalance()
  let response = `Used ${formatAmount(usedBalance)}/${formatAmount(user.maxBalance)} QSR\n`;

  for (const entry of user.entries) {
    if (entry.status === "active") {
      response = response + `✅ /${entry.sequenceNumber} ${formatAmount(entry.amount)} QSR to ${entry.beneficiary} [running]\n`
    } else if (entry.status === "pending") {
      response = response + `⏳ /${entry.sequenceNumber} ${formatAmount(entry.amount)} QSR to ${entry.beneficiary} [pending]\n`
    }
  }

  for (const entry of user.entries) {
    if (entry.status === "invalid" || entry.status === "canceled") {
      response = response + `❌ ${entry.sequenceNumber} ${formatAmount(entry.amount)} QSR to ${entry.beneficiary} [canceled]\n`
    }
  }

  return bot.sendMessage(msg.chat.id, response);
}

// handle /fuse {address} {amount} command
async function fuse(msg: TelegramBot.Message) {
  const user = getUser(msg)
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
    if (amount < 10 || isNaN(amount)) {
      return bot.sendMessage(msg.chat.id, `Amount too small. Needs to be bigger than 10 QSR. ${usage}`)
    }
  } catch {
    return bot.sendMessage(msg.chat.id, `Invalid address. ${usage}`)
  }

  // apply QSR decimals
  amount *= 1e8

  const usedBalance = user.usedBalance()
  const remaining = user.maxBalance - usedBalance
  console.log(usedBalance, remaining)
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

async function handleMsg(msg: TelegramBot.Message) {
  // record all messages in DB
  getUser(msg).messages.push(DBTelegramMessage.fromTelegramMessage(msg))

  const splits = msg.text!.split(' ')

  if (splits[0][0] !== "/") {
    return;
  }

  switch (splits[0]) {
    case '/start':
      return start(msg)
    case '/list':
      return list(msg)
    case '/fuse':
      return fuse(msg)
  }

  // handle /{number}
  const number = parseInt(splits[0].substring(1))
  if (!(isNaN(number) || number == 0)) {
    return cancelFuse(msg)
  }
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

  // set up telegram bot
  bot = new TelegramBot(config.telegramToken, {polling: true});
  bot.on('message', handleMsg)

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
