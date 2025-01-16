'use strict'

const mysql = require('mysql2');
const logger = require('../logs/logger');

module.exports = () => {
    return {
        pool: () => {
            return mysql.createPool({
                host: '192.168.0.16',
                port: '3306',
                user: 'root',
                password: 'spdlqj21',
                database: 'acr_v4',
                multipleStatements: true,
                waitForConnections: true,
                connectionLimit: 20,
                queueLimit: 0
            })
        },

        pool_check: (pool) => {
            pool.getConnection((err, connection) => {
                if (err) {
                    logger.error(`[ db:acrV4.js ] acrV4 DB CONNECTION ERROR : ${err}`);
                } else {
                    logger.info(`[ db:acrV4.js ] acrv4 DB CONNECTION SUCCESSFULLY`);
                    connection.release();
                }
            })
        }
    }
};