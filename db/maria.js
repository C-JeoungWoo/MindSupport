'use strict'

const mysql = require('mysql2');
const logger = require('../logs/logger');

module.exports = () => {
    return {
<<<<<<< HEAD
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
=======
        init: () => {
            return mysql.createConnection({
                host: '192.168.0.29',
                port: '3306',
                user: 'root',
                password: 'spdlqj21',
                database: 'ETRI_EMOTION',
                multipleStatements: true
>>>>>>> 34595daff823db6afe8501216d21d14acfbc0c45
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