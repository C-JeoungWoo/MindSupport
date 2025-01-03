'use strict'

const logger = require('../logs/logger');

let ErkApiMsg = null;
let ch = null;
let ch2 = null;
let ErkQueueInfo = null;
let ErkQueueInfo2 = null;

function setErkApiMsg(erkApiMsg, channel1, channel2, ErkQueueInfo11, ErkQueueInfo22) {
    ErkApiMsg = erkApiMsg;
    ch = channel1;
    ch2 = channel2;
    ErkQueueInfo = ErkQueueInfo11;
    ErkQueueInfo2 = ErkQueueInfo22;
    
    logger.info(`[ erkUtils.js:setErkApiMsg ] ErkApiMsg and channels set to: ${ErkApiMsg ? 'defined' : 'null'}`);
}

function getErkApiMsg() {
    if (!ErkApiMsg) {
        logger.error('[ erkUtils.js:getErkApiMsg ] ErkApiMsg is not initialized');
        throw new Error('[ erkUtils.js:getErkApiMsg ] ErkApiMsg not initialized');
    }

    return {
        ErkApiMsg,
        ch,
        ch2,
        ErkQueueInfo,
        ErkQueueInfo2
    };
}

module.exports = {
    setErkApiMsg,
    getErkApiMsg
};