'use strict'

const mysql = require('mysql2');
const logger = require('../logs/logger');

module.exports = () => {
    return {
        pool: () => {
            return mysql.createConnection({
<<<<<<< HEAD
                host: '192.168.0.19',
                port: '3306',
=======
<<<<<<< HEAD
                host: '192.168.0.24',
                port: '3306',
=======
                host: '192.168.0.3',
                port: '13307',
>>>>>>> 34595daff823db6afe8501216d21d14acfbc0c45
>>>>>>> refs/remotes/origin/main
                user: 'acr',
                password: 'Acr#600',
                database: 'acr_v4',
                multipleStatements: true,
                waitForConnections: true,
                connectionLimit: 20,
                queueLimit: 0
            })
        },

        pool_check: (con) => {
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