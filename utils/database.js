'use strict'

let connection = null;  // mindSupport DB
let connection2 = null; // acrV4 DB

module.exports = {
    setConnections: (conn1, conn2) => {
        connection = conn1;
        connection2 = conn2;
    },
    getConnection: () => connection,
    getAcrConnection: () => connection2
};