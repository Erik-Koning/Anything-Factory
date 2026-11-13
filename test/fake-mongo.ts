// An in-memory stand-in for the few driver calls the Mongo store makes (lib/tasks/mongo.ts), for the tests.
import type { MongoClientLike, MongoCollectionLike } from "../lib/tasks/mongo.ts";

export function fakeMongo(): MongoClientLike {
  const dbs = new Map<string, Map<string, Map<string, Record<string, unknown>>>>();
  const matches = (doc: Record<string, unknown>, filter: Record<string, unknown>) => Object.entries(filter).every(([k, v]) => doc[k] === v);
  return {
    db(name) {
      const db = dbs.get(name) ?? new Map();
      dbs.set(name, db);
      return {
        collection(cname): MongoCollectionLike {
          const docs = db.get(cname) ?? new Map<string, Record<string, unknown>>();
          db.set(cname, docs);
          const clone = (d: Record<string, unknown> | undefined) => (d ? structuredClone(d) : null);
          return {
            findOne: async (filter) => clone([...docs.values()].find((d) => matches(d, filter))),
            find: (filter) => ({ toArray: async () => [...docs.values()].filter((d) => matches(d, filter)).map((d) => structuredClone(d)) }),
            insertOne: async (doc) => {
              if (docs.has(String(doc._id))) throw Object.assign(new Error("duplicate"), { code: 11000 });
              docs.set(String(doc._id), structuredClone(doc));
            },
            replaceOne: async (filter, doc) => {
              const current = [...docs.values()].find((d) => matches(d, filter));
              if (!current) return { matchedCount: 0 };
              docs.set(String(current._id), structuredClone(doc));
              return { matchedCount: 1 };
            },
            findOneAndUpdate: async (filter, update) => {
              const id = String(filter._id);
              const doc = docs.get(id) ?? { _id: id, seq: 0 };
              const inc = (update.$inc ?? {}) as Record<string, number>;
              for (const [k, v] of Object.entries(inc)) doc[k] = Number(doc[k] ?? 0) + v;
              docs.set(id, doc);
              return structuredClone(doc);
            },
            updateOne: async (filter, update) => {
              const id = String(filter._id);
              const doc = docs.get(id) ?? { _id: id, seq: 0 };
              for (const [k, v] of Object.entries((update.$max ?? {}) as Record<string, number>)) doc[k] = Math.max(Number(doc[k] ?? 0), v);
              Object.assign(doc, structuredClone((update.$set ?? {}) as Record<string, unknown>));
              docs.set(id, doc);
            },
            createIndex: async () => "ok",
          };
        },
      };
    },
    close: async () => {},
  };
}
