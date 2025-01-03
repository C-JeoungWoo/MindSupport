'use strict'

const mysql = require('mysql2');
const logger = require('../logs/logger');

module.exports = () => {
    return {
        init: () => {
            return mysql.createConnection({
                host: '192.168.0.7',
                port: '3306',
                user: 'nbetri2',
                password: 'nb1234',
                database: 'MindSupport',
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