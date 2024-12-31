'use strict'

const mysql = require('mysql2');
const logger = require('../logs/logger');

module.exports = () => {
    return {
        init: () => {
            return mysql.createConnection({
                host: '192.168.0.19',
                port: '3306',
                user: 'root',
                password: 'spdlqj21',
                database: 'acr_v4',
                multipleStatements: true
            })
        },

        db_open: (con) => {
            con.connect((err) => {
                if (err) {
                    logger.error(`[ db:acrV4.js ] acrV4 DB CONNECTION ERROR : ${err}`);
                } else {
                    logger.info(`[ db:acrV4.js ] acrv4 DB CONNECTION SUCCESSFULLY`);
                    return;
                }
            })
        }
    }
};