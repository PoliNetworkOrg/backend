import pg from "pg";

const DB_NAME = process.env.DB_NAME;

const client = new pg.Client({
  host: process.env.DB_HOST!,
  port: parseInt(process.env.DB_PORT!),
  user: process.env.DB_USER!,
  password: process.env.DB_PASS!,
});

try {
  if (!DB_NAME) throw new Error("No DB_NAME was provided");

  await client.connect();
  const exists = await client
    .query(`SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'`)
    .then(({ rowCount }) => rowCount && rowCount === 1)
    .catch(() => false);

  if (!exists) await client.query(`CREATE DATABASE ${DB_NAME}`)
  console.log(`Database ${DB_NAME} ${exists ? "already exists" : "created"}`);
} catch (err) {
  console.error(err);
} finally {
  client.end();
}
