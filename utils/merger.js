// Helper file to migrate DB from V1 to V2

const fs = require("fs");

let oldDB = JSON.parse(fs.readFileSync("old-db.json").toString())['recipients'];
let entries = JSON.parse(fs.readFileSync("entries.json").toString());

const toBeConnected = {}
for (const number in entries) {
    const fuseEntry = entries[number]
    const address = fuseEntry.beneficiary
    if (!(address in toBeConnected)) {
        toBeConnected[address] = []
    }
    toBeConnected[address].push(fuseEntry)
}

const newDB = {
    "users": {}
}
for (const userId in oldDB) {
    const user = oldDB[userId]
    const address = user.msg.text
    if (address.length !== 40) {
        continue
    }

    const entry = toBeConnected[address].pop()

    newDB.users[userId] = {
        "messages": [
            {
                "messageId": user.msg.message_id,
                "date": user.msg.date,
                "text": user.msg.text
            }
        ],
        "nextFuseSequenceNumber": 2,
        "maxBalance": 5000000000,
        "entries": [
            {
                "sequenceNumber": 1,
                "beneficiary": entry.beneficiary,
                "amount": entry.amount,
                "id": entry.id,
                "creationTime": 0,
                "status": "active"
            },
        ]
    }
}

fs.writeFileSync("new-db.json", JSON.stringify(newDB))

