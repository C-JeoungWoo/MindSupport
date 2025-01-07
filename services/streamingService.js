'use strict'

const StreamProcessor = require('../managers/StreamProcessor');
const QueueManager = require('../managers/QueueManager');
const { findWavHeaderLength, convertGsmToPcm } = require('../services/audioUtils');
const { waitForRequiredSize } = require(`./audioProcessingService`);

const DIRECTORIES = require('../config/directories');
const logger = require('../logs/logger');
const fs = require('fs');              // 추가 필요
const fsp = require('fs').promises;    // 추가 필요
const path = require('path');

const { getErkApiMsg, setErkApiMsg } = require('../utils/erkUtils');

//  오디오 청크(데이터) 전송
async function sendAudioChunks(filePath, userId, options = {
    remainingDataSize: 0,
    totalFileSize: 0,
    gsmHeaderLength: 0,
    fileType: '', // 'rx' 또는 'tx',
    selectedQueue, // 누락된 인자 추가 (250107_최정우)
    login_id,
    org_id,
    user_uuid
}) {
    logger.info(`[ streamingService:sendAudioChunks ] 전달받은 filePath: ${filePath}`);

    try {
        const currentErkApiMsg = getErkApiMsg();

        // PCM 오디오 데이터 송신 기준
        const SAMPLE_RATE = 16000;        // 16kHz
        const BYTES_PER_SAMPLE = 2;       // 16비트(2바이트) 샘플
        const CHUNK_DURATION = 1;         // 1초 단위로 청크 분할
        const TOTAL_CHUNK_SIZE = 44000;   // MsgDataFrame의 고정 크기
        const RAW_CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_DURATION;  // 32000 바이트
        const PCM_HEADER_SIZE = options.gsmHeaderLength;       // PCM WAV 헤더 크기

        // 경로 관련
        const baseFileName = path.basename(filePath, '.wav');
        const checkedFilePath = filePath;
        const fileInfo_callId = path.basename(checkedFilePath, '.wav');

        // PCM 파일 읽기
        const data = await fsp.readFile(checkedFilePath);
        const file_audio = data.slice(PCM_HEADER_SIZE);    // 헤더 제거 후 raw PCM 데이터

        // Int16Array로 변환
        let fullData = new Int16Array(
            file_audio.buffer,
            file_audio.byteOffset,
            file_audio.byteLength / BYTES_PER_SAMPLE
        );

        // 청크 수 계산
        const numberOfChunks = Math.ceil(file_audio.byteLength / RAW_CHUNK_SIZE);
        logger.info(`FILEPATH: ${checkedFilePath}, PCM Header: ${PCM_HEADER_SIZE}, Chunks: ${numberOfChunks}`);
        logger.info(`FILENAME: ${fileInfo_callId}, Total size: ${data.byteLength}, Raw data size: ${file_audio.byteLength}`);

        // 큐 정보 설정
        const queueManager = new QueueManager(userId, options.fileType, currentErkApiMsg);
        const queueConfig = await queueManager.fetchQueueInfo(currentErkApiMsg);

        // StreamProcessor 초기화 및 처리
        const streamProcessor = new StreamProcessor();
        const processResult = await streamProcessor.processFileStream(
            checkedFilePath, 
            currentErkApiMsg,
            {
                audioData: fullData,
                totalChunks: numberOfChunks,
                rawChunkSize: RAW_CHUNK_SIZE,
                totalChunkSize: TOTAL_CHUNK_SIZE,
                userId,
                fileInfo_callId,
                ...queueConfig,
                // isLastChunk: options.isLastChunk,
                fileType: options.fileType
            }
        );

        return processResult;
    } catch(err) {
        logger.error(`[ streamingService.js:sendAudioChunks ] sendAudioChunks 함수에서 오류 발생: ${err}`);
        return { success: false, message: err.message };
    }
}

module.exports = { sendAudioChunks };