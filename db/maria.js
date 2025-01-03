'use strict'

const mysql = require('mysql2');
const logger = require('../logs/logger');

module.exports = () => {
    return {
        init: () => {
            return mysql.createConnection({
                host: '192.168.0.29',
                port: '3306',
                user: 'root',
                password: 'spdlqj21',
                database: 'ETRI_EMOTION',
                multipleStatements: true
            })
        },

        db_open: (con) => {
            con.connect(err => {
                if (err) {
                    logger.error(`[ db:maria.js ] MindSupport DB CONNECTION ERROR : ${err}`);
                } else {
                    logger.info(`[ db:maria.js ] MindSupport DB CONNECTION SUCCESSFULLY`);
                    return;
                }
            })
        }
    }
};