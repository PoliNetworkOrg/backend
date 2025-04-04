import pg from "pg";

const { Client } = pg;

const DB_NAMES = [process.env.DB_NAME_TG, process.env.DB_NAME_WEB]
export async function createDb(dbName: string): Promise<void> {
  const baseConfig = {
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT!),
    user: process.env.DB_USER!,
    password: process.env.DB_PASS!,
    ssl: false,
  };

  const client = new Client(baseConfig);
  try {
    await client.connect();
    const res = await client.query(
      `SELECT 1 FROM pg_database WHERE datname=$1::text`,
      [dbName],
    );
    if (!res.rows[0]) { 
      await client.query(`CREATE DATABASE ${dbName}`);
      console.log(`CREATED DATABASE ${dbName}`)
    } else {
      console.log(`DATABASE ${dbName} ALREADY EXISTS`)
    }
  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}

for (const dbName of DB_NAMES) {
  if (dbName) await createDb(dbName)
  else console.log("skipping invalid dbName", dbName)
}
