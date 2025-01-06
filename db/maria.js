'use strict'

const mysql = require('mysql2');
const logger = require('../logs/logger');

module.exports = () => {
    return {
        pool: () => {
            return mysql.createPool({
                host: '192.168.0.30',
                port: '3306',
                user: 'emo10',
                password: 'nb1234',
                database: 'ETRI_EMOTION',
                multipleStatements: true,
                waitForConnections: true,
                connectionLimit: 20,
                queueLimit: 0
            })
        },

        pool_check: (pool) => {
            pool.getConnection((err, connection) => {
                if (err) {
                    logger.error(`[ db:maria.js ] MindSupport DB CONNECTION ERROR : ${err}`);
                } else {
                    logger.info(`[ db:maria.js ] MindSupport DB CONNECTION SUCCESSFULLY`);
                    connection.release();
                }
            });
        }
    }
};