import dotenv from "dotenv"

export class Config {
  telegramToken: string
  mnemonic: string
  url: string
  dbPath: string

  constructor(telegramToken: string, mnemonic: string, url: string, dbPath: string) {
    this.telegramToken = telegramToken
    this.mnemonic = mnemonic
    this.url = url
    this.dbPath = dbPath
  }
}

function parseEnvConfig(fieldName: string, defaultValue?: string): string {
  if (fieldName in process.env) {
    return process.env[fieldName] as string
  } else {
    if (defaultValue) {
      return defaultValue
    } else {
      throw `must provide ${fieldName} in .env file`
    }
  }
}

export function getConfig(): Config {
  dotenv.config()

  const telegramToken = parseEnvConfig("TELEGRAM_TOKEN")
  const mnemonic = parseEnvConfig("MNEMONIC")
  const url = parseEnvConfig("URL")
  const dbPath = parseEnvConfig("DB_PATH", "./db.json")
  return new Config(telegramToken, mnemonic, url, dbPath)
}
