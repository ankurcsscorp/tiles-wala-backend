
import pg from 'pg';

const { Pool } = pg;

export const connection = new Pool({
    host: 'localhost',
    user: 'postgres',
    port: 5432,
    password: "Ankur@1996",
    database: 'tilesWala'
});

connection.on('connect', () => {
    console.log('✅ PostgreSQL connection established');
});

connection.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err.message);
});
