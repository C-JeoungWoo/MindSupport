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

const { getErkApiMsg } = require('../utils/erkUtils');

//  오디오 청크(데이터) 전송
async function sendAudioChunks(filePath, userId, options = {
    isLastChunk: false,
    remainingDataSize: 0,
    totalFileSize: 0,
    gsmHeaderLength: 0,
    fileType: '' // 'rx' 또는 'tx'
}) {
    logger.info(`[ app.js:sendAudioChunks ] 전달받은 filePath: ${filePath}`);

    try {
        const currentErkApiMsg = getErkApiMsg();

        // 3. StreamProcessor 초기화 및 설정
        const streamProcessor = new StreamProcessor({ maxBufferSize: 1024 * 1024 });

        // GSM6.10 코덱 관련 상수
        const GSM_BYTES_PER_SECOND = 1630;
        const SECONDS_TO_EXTRACT = 3;
        const CHUNK_SIZE = GSM_BYTES_PER_SECOND * SECONDS_TO_EXTRACT;  // 4890 bytes (3초 분량)

        // 경로 관련
        const baseFileName = path.basename(filePath, '.wav');
        const getGsmPath = (chunkNum) => path.join(DIRECTORIES.TEMP_GSM, `${baseFileName}_${(chunkNum-1)*SECONDS_TO_EXTRACT}-${chunkNum*SECONDS_TO_EXTRACT}sec.gsm`);

        //  chunk number
        let chunkNumber = 1;
        const chunkStartPosition = options.gsmHeaderLength + (CHUNK_SIZE * (chunkNumber - 1));
        const requiredSizeForCurrentChunk = options.gsmHeaderLength + (CHUNK_SIZE * chunkNumber);
        await waitForRequiredSize(filePath, requiredSizeForCurrentChunk );
        await new Promise(resolve => setTimeout(resolve, 100));  // 추가 안전 마진

        // 청크 데이터 읽기
        const checkedFilePath = filePath;
        const fileHandle = await fsp.open(filePath, 'r');
        const gsmData = Buffer.alloc(CHUNK_SIZE);
        const { bytesRead } = await fileHandle.read(gsmData, 0, CHUNK_SIZE, chunkStartPosition);
        await fileHandle.close();

        if (bytesRead === 0) { logger.info(`[ streamingService.js:sendAudioChunks ] No more data available after chunk ${chunkNumber - 1}`); }

        // 임시 GSM 청크 파일 생성
        const tempGsmPath = getGsmPath(chunkNumber);
        await fsp.writeFile(tempGsmPath, gsmData.slice(0, bytesRead));

        // GSM to PCM 변환 실행
        const conversionResult = await convertGsmToPcm(tempGsmPath, chunkNumber);
        if (conversionResult.message === 'success') {
            logger.info(`[ app.js:convertGsmToPcm ] Successfully converted chunk ${chunkNumber}`);

            // PCM 파일의 헤더 길이 확인
            const { result: pcmHeaderLength, filePath: checkedPcmFile } = await findWavHeaderLength(conversionResult.outputFile);
            logger.info(`${checkedPcmFile} header length: ${pcmHeaderLength} bytes for chunk ${chunkNumber}`);

            const data = await fsp.readFile(checkedFilePath);
            const fileInfo_callId = path.basename(checkedFilePath, '.wav');    // 확장자 명을 제외한 파일명을 반환
            const file_audio = data.slice(pcmHeaderLength);    // 헤더 제거 후 file_audio
            let fullData = new Int16Array(
                file_audio.buffer, 
                file_audio.byteOffset, 
                file_audio.byteLength / streamProcessor.bytesPerSample  // 클래스의 값 사용
            );

            //////////////////////////////////////////////////// 오디오 데이터 송신 ////////////////////////////////////////////////////

            // 청크 수 계산 시 StreamProcessor의 설정값 사용
            const numberOfChunks = Math.ceil(
                fullData.length / (streamProcessor.rawChunkSize / streamProcessor.bytesPerSample)
            );
            logger.info(`FILEPATH : ${checkedFilePath}, FILEHEADER 크기: ${pcmHeaderLength}, numberOfChunks: ${numberOfChunks}`);
            logger.info(`FILENAME : ${fileInfo_callId}, 원본 FILEDATA 크기: ${data.byteLength}, 자른 후 FILEDATA 크기: ${file_audio.byteLength}`);

            //    - ErkDataHeader 선언 및 SpeechEmoRecogRQ 선언
            //   3.1. Erk 큐 정보
            const queueManager = new QueueManager(userId, options.fileType, currentErkApiMsg);
            const queueConfig = await queueManager.fetchQueueInfo(currentErkApiMsg);

            // 스트림 처리 시작
            const processResult = await streamProcessor.processFileStream(checkedFilePath, {
                audioData: fullData,
                totalChunks: numberOfChunks,
                userId,
                fileInfo_callId,
                headerLength: pcmHeaderLength,
                logDir,
                ...queueConfig,  // 큐 설정 포함
                isLastChunk: options.isLastChunk,
                fileType: options.fileType,
                queueName: results[0].erkengineInfo_return_recvQueueName,
                ch: ch
            });

            // 임시 GSM 파일 삭제
            await fsp.unlink(tempGsmPath);
            chunkNumber++;
            
            return processResult;
        } else {
            await fsp.unlink(tempGsmPath);  // 실패 시에도 임시 파일 삭제
            throw new Error(`[ app.js:handleNewFile ] Conversion failed for chunk ${chunkNumber}`);
        }
    } catch(err) {
        logger.error(`[ app.js:sendAudioChunks ] sendAudioChunks 함수에서 오류 발생: ${err}`);
        return { success: false, message: err.message };
    }
}

module.exports = { sendAudioChunks };