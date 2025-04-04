import pg from "pg";

async function createDb() {
  const dbName = process.env.DB_NAME;

  const client = new pg.Client({
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT!),
    user: process.env.DB_USER!,
    password: process.env.DB_PASS!,
    database: undefined,
  });

  try {
    if (!dbName) throw new Error("No DB_NAME was provided");

    await client.connect();
    await client.query(`CREATE DATABASE ${dbName}`);
    console.log(`Database ${dbName} created or already existing`);
  } catch (err) {
    console.error(err, dbName);
  } finally {
    client.end();
  }
}

createDb();
