import TelegramBot from "node-telegram-bot-api";

const fs = require('fs');

export class DBFuseEntry {
  sequenceNumber: number = 0
  beneficiary: string = ""
  amount: number = 0
  id: string = ""
  creationTime: number = 0
  status: "pending" | "active" | "canceled" | "invalid" = "invalid"

  constructor() {
  }

  static deserialize(json: object): DBFuseEntry {
    const obj = new DBFuseEntry()
    // @ts-ignore
    obj.sequenceNumber = json['sequenceNumber']
    // @ts-ignore
    obj.beneficiary = json['beneficiary']
    // @ts-ignore
    obj.amount = json['amount']
    // @ts-ignore
    obj.id = json['id']
    // @ts-ignore
    obj.creationTime = json['creationTime']
    // @ts-ignore
    obj.status = json['status']
    return obj
  }

  serialize() {
    return {
      sequenceNumber: this.sequenceNumber,
      beneficiary: this.beneficiary,
      amount: this.amount,
      id: this.id,
      creationTime: this.creationTime,
      status: this.status
    }
  }
}

export class DBTelegramMessage {
  messageId: number = 0
  date: number = 0
  text: string = ""

  private constructor() {}

  static fromTelegramMessage(msg: TelegramBot.Message): DBTelegramMessage {
    const obj = new DBTelegramMessage()

    obj.messageId = msg.message_id
    obj.date = msg.date
    obj.text = msg.text || ""

    return obj
  }

  static deserialize(json: object): DBTelegramMessage {
    const obj = new DBTelegramMessage()
    // @ts-ignore
    obj.messageId = json['messageId']
    // @ts-ignore
    obj.date = json['date']
    // @ts-ignore
    obj.text = json['text']
    return obj
  }

  serialize() {
    return {
      messageId: this.messageId,
      date: this.date,
      text: this.text
    }
  }
}

export class DBUser {
  id: string
  messages: DBTelegramMessage[] = []

  nextFuseSequenceNumber: number = 1
  entries: DBFuseEntry[] = [];
  maxBalance: number = 50 * 1e8

  constructor(id: string) {
    this.id = id
  }

  newSequenceNumber(): number {
    const next = this.nextFuseSequenceNumber
    this.nextFuseSequenceNumber += 1
    return next
  }

  usedBalance(): number {
    let balance = 0
    for (const entry of this.entries) {
      if (entry.status === 'pending' || entry.status === 'active') {
        balance += entry.amount
      }
    }
    return balance
  }

  static deserialize(json: object, id: string): DBUser {
    // @ts-ignore
    const obj = new DBUser(id)
    // @ts-ignore
    obj.messages = json["messages"].map((x) => DBTelegramMessage.deserialize(x))

    // @ts-ignore
    obj.nextFuseSequenceNumber = json["nextFuseSequenceNumber"]
    // @ts-ignore
    obj.entries = json["entries"].map((x) => DBFuseEntry.deserialize(x))
    // @ts-ignore
    obj.maxBalance = json["maxBalance"]
    return obj
  }

  serialize() {
    return {
      messages: this.messages.map(((value) => value.serialize())),
      nextFuseSequenceNumber: this.nextFuseSequenceNumber,
      entries: this.entries.map(((value) => value.serialize())),
      maxBalance: this.maxBalance
    }
  }
}

// big object - keeps track of all
export class DB {
  location: string

  // mapping from userId -> DBUser
  users: Map<string, DBUser>

  constructor(location: string) {
    this.location = location
    this.users = new Map<string, DBUser>()
  }

  newUser(id: string): DBUser {
    const user = new DBUser(id)
    this.users.set(id, user)
    return user
  }

  serialize(): Object {
    const dumped = {
      users: {}
    }

    this.users.forEach((value, userId) => {
      // @ts-ignore
      dumped.users[userId] = value.serialize()
    })

    return dumped
  }

  deserialize(json: any) {
    for (const key in json['users'] ?? {}) {
      this.users.set(key, DBUser.deserialize(json.users[key], key))
    }
  }

  load() {
    if (fs.existsSync(this.location)) {
      let json = JSON.parse(fs.readFileSync(this.location).toString());
      this.deserialize(json)
    }
  }

  save() {
    fs.writeFileSync(this.location, JSON.stringify(this.serialize()))
  }
}
