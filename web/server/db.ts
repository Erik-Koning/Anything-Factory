// One MongoClient for the app, kept across hot reloads and warm serverless invocations. It holds both databases: the
// task graphs (A6G_DATABASE) and the accounts (AUTH_DATABASE).
import { type Db, MongoClient } from "mongodb";
import { config } from "./config.ts";

const cache = globalThis as typeof globalThis & { a6gWebMongo?: MongoClient };

// A connection idle for a minute is closed rather than kept: the site is quiet for minutes at a time, and a network
// between the container and the database can drop an idle connection without a word, so the next query on it would
// hang. And no call waits on a connection more than 20 seconds: a page fails with its error (logged, and an error page)
// before the CDN's 30 seconds give the browser a bare 504.
export function mongo(): MongoClient {
  cache.a6gWebMongo ??= new MongoClient(config().mongoUri, {
    appName: "a6g-web",
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8000,
    maxIdleTimeMS: 60_000,
    socketTimeoutMS: 20_000,
  });
  return cache.a6gWebMongo;
}

export const authDb = (): Db => mongo().db(config().authDatabase);
export const graphDb = (): Db => mongo().db(config().a6gDatabase);

// For scripts and tests: closes the client so the process can end.
export async function closeMongo(): Promise<void> {
  const client = cache.a6gWebMongo;
  delete cache.a6gWebMongo;
  await client?.close();
}
