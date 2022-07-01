import TelegramBot from 'node-telegram-bot-api';

// By default, the TelegramBot.on('message', callback) executes the callback each time a new message is received.
// If the callback is an async function, it doesn't wait for it to finish before it starts executing a new function.
// This can be a problem, because it's possible to have multiple `handleMsg` functions executing the workflow in the
// same time. Due to the async nature of JS, they don't execute in parallel, but external calls
// (awaits done by the functions) can merge the order in which they execute.
class SyncTelegramBot extends TelegramBot {
  // mutex to limit the handling of just one event at a time
  running: boolean
  events: TelegramBot.Message[]
  handleMessage: (msg: TelegramBot.Message) => Promise<TelegramBot.Message>

  constructor(token: string, handleMessage: (msg: TelegramBot.Message) => Promise<TelegramBot.Message>) {
    super(token, {polling: true})
    this.running = false
    this.events = []
    this.handleMessage = handleMessage

    this.on('message', this.onNewMessage.bind(this))
    this.start()
  }

  onNewMessage(event: TelegramBot.Message) {
    this.events.push(event)
  }

  async handleOneMessage() {
    // limit to just one handle message at a time
    // setInterval doesn't wait for this function to finish running before it executes again
    // so a mutex which shortcuts the execution is required.
    if (this.running) {
      return
    }

    this.running = true
    const event = this.events.pop()
    if (event) {
      try {
        await this.handleMessage(event!)
      } catch(e) {
        console.log(`Failed to handle message. reason:${e}`)
      }
    }

    this.running = false
  }

  start() {
    setInterval(this.handleOneMessage.bind(this), 100)
  }
}

export = SyncTelegramBot;
