'use strict'

const DateUtils = require('../utils/dateUtils');
const StreamProcessor = require('../managers/StreamProcessor');
const streamProcessor = new StreamProcessor();
const StreamingService = require(`../services/streamingService`);

const { setErkApiMsg, getErkApiMsg } = require('../utils/erkUtils');  // erkUtils에서 가져오기

const logger = require('../logs/logger');
const fsp = require('fs').promises;
const path = require('path');

const mysql = require('../db/maria')();
const connection1 = mysql.init();
mysql.db_open(connection1);

const mysql2 = require('../db/acrV4')();
const connection2 = mysql.init();
mysql2.db_open(connection2);

//  생성된 WAV 파일 처리
const handleNewFile = async function handleNewFile(filePath, userid) {
    logger.info(`[ audioServices.js:handleNewFile ] 처리요청 받은 RX/TX 파일경로: ${filePath}`);
            
    // ErkApiMsg 상태 확인
    const currentErkApiMsg = getErkApiMsg();
    logger.debug(`[ audioServices.js:EmoServiceStartRQ ] Current ErkApiMsg status: ${currentErkApiMsg ? 'defined' : 'undefined'}`);

    try {
        const baseFileName = path.basename(filePath, '.wav');
        const caller_id = baseFileName.split('_')[2]; // 상담원일지 고객일지는 모름.

        let previousSize = 0;
        let unchangedCount = 0;
        let chunkNumber = 1;  // 추가 필요
        const MAX_UNCHANGED_COUNT = 30;  // 3초

        // GSM 6.10 WAV 파일 무결성 및 헤더 길이 체크
        const result  = await checkGsm610WavFileIntegrity(filePath);
        if (result.status !== 'valid') {  // 조건문도 수정 필요 (!result.status === 'valid'는 잘못된 비교)
            logger.warn(`[ audioServices.js:handleNewFile ] New file is invalid`);
            return null;
        }
        const { gsmHeaderLength } = result;  // result에서 gsmHeaderLength 추출
        logger.info(`[ audioServices.js:handleNewFile ] File integrity check passed, header length: ${gsmHeaderLength} bytes`);

        // 3. EmoServiceStartRQ 에서 DB 조회한 결과 전달 (한 번만)
        // const serviceResponse = await EmoServiceStartRQ(baseFileName);

        while (true) {
            try {
                // 1. 현재 상태 체크
                const [fileStats, recordingStatus] = await Promise.all([
                    fsp.stat(filePath),
                    new Promise((resolve, reject) => {
                        let recordingStatus_qry = `SELECT REC_END_DATETIME 
                        FROM acr_v4.t_rec_data${DateUtils.getYearMonth()}
                        WHERE AGENT_TELNO = '${caller_id}'
                        AND DATE(REC_START_DATE) = CURDATE()
                        ORDER BY REC_START_DATE DESC LIMIT 1;`;
                        connection2.query(recordingStatus_qry, (error, results) => {
                            if (error) reject(error);
                            resolve(results[0]);
                        });
                    })
                ]);

                // 2. 파일 크기 변화 체크
                const currentSize = fileStats.size;
                const isFileSizeUnchanged = currentSize === previousSize;
                
                // 3. 파일 크기 안정화 카운트
                if (isFileSizeUnchanged) unchangedCount++;
                else unchangedCount = 0;

                // 4. 녹취 종료 조건 체크
                // const isRecordingComplete = 
                //     (recordingStatus.REC_END_DATETIME !== null) &&        // DB 종료
                //     (unchangedCount >= MAX_UNCHANGED_COUNT);        // 파일 크기 안정화

                const isRecordingComplete = unchangedCount >= MAX_UNCHANGED_COUNT;        // 파일 크기 안정화
                let remainingDataSize = currentSize - (gsmHeaderLength + (1630 * (chunkNumber - 1)));
                if (isRecordingComplete) {
                    // logger.info(`[ audioServices.js:handleNewFile ] Recording completed.
                    //     DB Status: ${!!recordingStatus.REC_END_DATETIME},
                    //     File Stable: ${unchangedCount >= MAX_UNCHANGED_COUNT}`
                    // );
                    
                    // 마지막 청크 처리를 위한 sendAudioChunks 호출
                    const sendResult = await StreamingService.sendAudioChunks(filePath, userid, currentErkApiMsg, {
                        isLastChunk: true,  // 마지막 청크 표시
                        remainingDataSize: remainingDataSize,   // 남은 데이터 크기
                        totalFileSize: currentSize, // 전체 파일 크기
                        gsmHeaderLength: gsmHeaderLength,   // WAV 헤더 크기
                        fileType: filePath.includes('RX') ? 'RX' : 'TX'  // rx 또는 tx
                    });
                    logger.info(`[ audioServices.js:handleNewFile ] Final chunk processed with ${remainingDataSize} bytes of data`);
                    
                    if (!sendResult.success) {
                        logger.error(`[ audioServices.js:convertGsmToPcm ] Failed to send audio chunk ${chunkNumber}: ${sendResult.message}`);
                    } else {
                        logger.info(`[ audioServices.js:handleNewFile ] Successfully processed chunk ${chunkNumber}`);

                        //  EmoServiceStopRQ-RP
                        try {
                            // StreamProcessor를 통한 마지막 청크 처리
                            const processResult = await streamProcessor.processFileStream(filePath, currentErkApiMsg, {
                                isLastChunk: true,
                                remainingDataSize: remainingDataSize,
                                totalFileSize: currentSize,
                                gsmHeaderLength: gsmHeaderLength,
                                fileType: filePath.includes('RX') ? 'RX' : 'TX',
                                userId: userid,
                                chunkNumber,
                                login_id: serviceResponse.login_id,    // 추가
                                org_id: serviceResponse.org_id,        // 추가
                                user_uuid: serviceResponse.user_uuid    // 추가
                            });

                            if (processResult.success) {
                                logger.info(`[ audioServices.js:handleNewFile ] Final chunk processed successfully with ${remainingDataSize} bytes of data`);
                                
                                // AudioFileManager를 통한 종료 처리
                                await AudioFileManager.handleProcessingComplete(filePath, userid);
                            } else {
                                logger.error(`[ audioServices.js:handleNewFile ] Failed to process final chunk: ${processResult.message}`);
                            }
                        } catch (error) {
                            logger.error(`[ audioServices.js:handleNewFile ] Error sending EmoServiceStop request: ${error}`);
                        }
                    }
                } else {
                    // StreamProcessor를 통한 일반 청크 처리
                    const processResult = await streamProcessor.processFileStream(filePath, currentErkApiMsg, {
                        isLastChunk: false,
                        remainingDataSize: remainingDataSize,
                        totalFileSize: currentSize,
                        gsmHeaderLength: gsmHeaderLength,
                        fileType: filePath.includes('RX') ? 'RX' : 'TX',
                        userId: userid,
                        chunkNumber,
                        login_id: serviceResponse.login_id,    // 추가
                        org_id: serviceResponse.org_id,        // 추가
                        user_uuid: serviceResponse.user_uuid    // 추가
                    });

                    if (!processResult.success) {
                        logger.error(`[ audioServices.js:handleNewFile ] Failed to process chunk ${chunkNumber}: ${processResult.message}`);
                    } else {
                        logger.info(`[ audioServices.js:handleNewFile ] Successfully processed chunk ${chunkNumber}`);

                        chunkNumber++;  // 성공 시 청크 번호 증가
                    }
                }

                // 7. 상태 업데이트
                previousSize = currentSize;
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                if (error.message.includes('Timeout waiting for')) {
                    // 타임아웃이 발생하면 다음 데이터를 기다림
                    logger.warn(`[ audioServices.js:handleNewFile ] Waiting for more data after chunk ${chunkNumber - 1}`);
                    continue;
                } else {
                    throw error;
                }
            }
        }
    } catch(err) {
        logger.error(`[ audioServices.js:handleNewFile ] Error handling file ${filePath}`);
        logger.error(`[ audioServices.js:handleNewFile ] ${err}`);
    }
}

//  생성된 wav 파일 처리에 대해 엔진 사용 요청
const EmoServiceStartRQ = async function EmoServiceStartRQ (path) {
    try {
        // EmoServiceStartRQ 함수 시작 부분에 erkUtils에서 값 가져오기
        const { ErkApiMsg, ch, ch2, ErkQueueInfo, ErkQueueInfo2 } = getErkApiMsg();

        logger.debug(`[ audioServices.js:EmoServiceStartRQ ] Current ErkApiMsg status: ${ErkApiMsg  ? 'defined' : 'undefined'}`);
        logger.warn(`[ audioServices.js:EmoServiceStartRQ ] 전달받은 File Path: ${path}`);

        // Promise.all을 사용한 병렬 쿼리 실행
        //  - 파일명에서 내선번호로 JOIN
        let caller_id = path.split('_')[2];

        const [connResults, conn2Results] = await Promise.all([
            //  MindSupport Database → 전체 유저 중 활성 세션 유저 조회
            new Promise((resolve, reject) => {
                connection1.query(`SELECT
                        session_id,
                        JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.org_id')) as user_orgid,
                        JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.userinfo_uuid')) as user_uuid,
                        JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.cusinfo_uuid')) as user_uuid2,
                        eui.*
                    FROM sessions s
                    LEFT JOIN emo_user_info eui
                        ON eui.login_id = JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.login_id'));`, (error, results) => {
                    if (error) reject(error);
                    resolve(results);
                });
            }),
            //  녹취 Database → 해당 내선번호의 유저 조회
            new Promise((resolve, reject) => {
                connection2.query(`SELECT * 
                    FROM acr_v4.t_rec_data${DateUtils.getYearMonth()}
                    WHERE AGENT_TELNO = '${caller_id}';`, (error, results) => { // 테스트 시 제외함 -> AND REC_END_DATETIME IS NULL;
                    if (error) reject(error);
                    resolve(results);
                });
            })
        ]);

        // 조인 로직 최적화 (Map 사용)
        const remoteMap = new Map( conn2Results.map(row => [row.rec_id, row]) );
        const joinedData = connResults.map(localRow => ({
            ...localRow,
            ...remoteMap.get(localRow.rec_id)
        }));

        //  ESSRQ 메세지 헤더 구성
        let ErkMsgHead = ErkApiMsg.create({
            MsgType: 21,
            TransactionId: joinedData[0].userinfo_uuid,
            QueueInfo: ErkQueueInfo,
            OrgId: parseInt(joinedData[0].user_orgid),  // OrgId: parseInt(joinedData[0].user_orgid)
            UserId: parseInt(joinedData[0].userinfo_userId)  // 상담원10명 셋팅(고객은 userinfo_userId + 10 로 매핑) UserId: parseInt(joinedData[0].userinfo_userId)
        });
        let ErkMsgHead_cus = ErkApiMsg.create({
            MsgType: 21,
            TransactionId: joinedData[0].cusinfo_uuid,
            QueueInfo: ErkQueueInfo2,
            OrgId: parseInt(joinedData[0].user_orgid),
            UserId: parseInt(joinedData[0].userinfo_userId) + 10
        });

        //  ESSRQ 메세지 구성
        let EmoServiceStartMsg = ErkApiMsg.create({
            EmoServiceStartRQ: {
                ErkMsgHead: ErkMsgHead,
                MsgTime: DateUtils.getCurrentTimestamp(), // 년월일시분초밀리초
                ServiceType: joinedData[0].userinfo_serviceType,
                EmoRecogType: 1    // 개인감성 or 사회감성
            }
        });
        let EmoServiceStartMsg_cus = ErkApiMsg.create({
            EmoServiceStartRQ: {
                ErkMsgHead: ErkMsgHead_cus,
                MsgTime: DateUtils.getCurrentTimestamp(),
                ServiceType: joinedData[0].userinfo_serviceType,
                EmoRecogType: 1
            }
        });
        
        //  메세지 인코딩
        let EmoServiceStartMsg_buf = ErkApiMsg.encode(EmoServiceStartMsg).finish();
        let EmoServiceStartMsg_buf_cus = ErkApiMsg.encode(EmoServiceStartMsg_cus).finish();

        const sendAndWaitForResponse = () => {
            return Promise.all([
                // Channel 1 전송 및 응답 대기
                new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        logger.warn(`[ audioServices.js:EmoServiceStartRQ ] Channel 1 response timeout`);
                        resolve(null);
                    }, 5000);

                    connection1.query(`UPDATE emo_user_info SET erkEmoSrvcStart_send_dt = NOW(3)
                        WHERE userinfo_userId = ${parseInt(joinedData[0].userinfo_userId)};`, (error, results) => {
                        if (error) reject(error);

                        // 메시지 전송
                        logger.info(`[ audioServices.js:EmoServiceStartRQ ] con 업데이트 후 메세지 송신\n${JSON.stringify(EmoServiceStartMsg, null, 4)}`);
                        ch.sendToQueue("ERK_API_QUEUE", EmoServiceStartMsg_buf);

                        resolve(results);
                    });
                }),
                // Channel 2 전송 및 응답 대기
                new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        logger.warn(`[ audioServices.js:EmoServiceStartRQ ] Channel 2 response timeout`);
                        resolve(null);
                    }, 5000);

                    connection1.query(`UPDATE emo_user_info SET erkEmoSrvcStart_send_dt = NOW(3)
                        WHERE userinfo_userId = ${parseInt(joinedData[0].userinfo_userId) + 11};`, (error, results) => {
                        if (error) reject(error);

                        // 메시지 전송
                        logger.info(`[ audioServices.js:EmoServiceStartRQ ] cus 업데이트 후 메세지 송신\n${JSON.stringify(EmoServiceStartMsg_cus, null, 4)}`);
                        ch2.sendToQueue("ERK_API_QUEUE", EmoServiceStartMsg_buf_cus);

                        resolve(results);
                    });
                })
            ]);
        }

        //  단일 이벤트에 대한 결과 수신 후 return
        const responses = await sendAndWaitForResponse();
        if (responses[0] && responses[1]) {
            logger.info(`[ audioServices.js:sendAndWaitForResponse ] Both channels responded successfully`);

            return {
                message: 'success',
                return_type: 1,
                userinfo_userId: joinedData[0].userinfo_userId,
                // 추가 정보
                login_id: joinedData[0].login_id,
                org_id: parseInt(joinedData[0].user_orgid),
                user_uuid: joinedData[0].user_uuid
            };
        } else {
            throw new Error(`Response failed: ${!responses[0] ? 'Channel 1 ' : ''}${!responses[1] ? 'Channel 2' : ''}`);
        }
    } catch(err) {
        logger.error(`[ audioServices.js:EmoServiceStartRQ ] ${err}`);
        return {
            message: 'error',
            return_type: 0,
            error: err.message
        };
    }
}

//  생성된 wav 통화 파일에 대한 데이터 처리가 더 없을 경우
const EmoServiceStopRQ = async function EmoServiceStopRQ(userinfo_userId) {
    try {
        logger.info(`[ audioServices.js:EmoServiceStopRQ ] Stopping service for user: ${userinfo_userId}`);

        // getErkApiMsg 함수로 ErkApiMsg 상태 검증
        const currentErkApiMsg = getErkApiMsg();
        logger.debug(`[ audioServices.js:EmoServiceStopRQ ] Current ErkApiMsg status: ${currentErkApiMsg  ? 'defined' : 'undefined'}`);

        return Promise.all([
            new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    logger.warn(`[ audioServices.js:EmoServiceStartRQ ] Channel 2 response timeout`);
                    resolve(null);
                }, 5000);

                //
                connection1.query(`SELECT
                    session_id,
                    JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.org_id')) as user_orgid,
                    JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.userinfo_uuid')) as user_uuid,
                    JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.cusinfo_uuid')) as user_uuid2,
                    eui.*
                FROM sessions s
                LEFT JOIN emo_user_info eui
                    ON eui.login_id = JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.login_id'))
                WHERE eui.userinfo_userid = ${userinfo_userId};`, (err, results) => {
                    if(err) {
                        logger.error(`[ app.js:EmoServiceStopRQ ] ${err}`);
                        reject(err);
                    }

                    if (results.length > 0) {
                        let ErkMsgHead = currentErkApiMsg.create({
                            MsgType: 23,
                            TransactionId: results[0].userinfo_uuid,
                            QueueInfo: ErkQueueInfo,
                            OrgId: results[0].org_id,
                            UserId: results[0].userinfo_userId
                        });

                        let EmoServiceStopMsg = currentErkApiMsg.create({
                            EmoServiceStopRQ: {
                                ErkMsgHead: ErkMsgHead,
                                EmoRecogType: 1,    // 개인감성 or 사회감성
                                MsgTime: DateUtils.getCurrentTimestamp(),   // 년월일시분초밀리초
                                ServiceType: results[0].userinfo_serviceType,
                                PhysioEngine_ReceiveQueueName: "",
                                PhysioEngine_SendQueueName: "",
                                SpeechEngine_ReceiveQueueName: `${results[0].erkengineInfo_return_recvQueueName}`,
                                SpeechEngine_SendQueueName: `${results[0].erkengineInfo_return_sendQueueName}`,
                                FaceEngine_ReceiveQueueName: "",
                                FaceEngine_SendQueueName: "",
                                KnowledgeEngine_ReceiveQueueName: "",
                                KnowledgeEngine_SendQueueName: "",
                            }
                        });
                        let EmoServiceStopMsg_buf = currentErkApiMsg.encode(EmoServiceStopMsg).finish();
                        logger.info(`[ audioServices.js:EmoServiceStopRQ ] 생성된 EmoServiceStopRQ 메세지\n${JSON.stringify(EmoServiceStopMsg_buf, null, 4)}`);

                        let emoSerStop_send_rq = `UPDATE emo_user_info
                        SET erkEmoSrvcStop_send_dt = NOW(3)
                        WHERE userinfo_userId = ${results[0].userinfo_userId};`;
                        connection1.query(emoSerStop_send_rq, (err, results) => {
                            if (err) {
                                logger.error(`[ audioServices.js:EmoServiceStopRQ ] ${err}`);
                                reject(err);
                                return;
                            }
    
                            logger.info(`[ audioServices.js:EmoServiceStopRQ ] DB 업데이트 후 메세지 송신`);
                            ch.sendToQueue("ERK_API_QUEUE", EmoServiceStopMsg_buf);

                            resolve('success');
                        });
                    }

                    resolve(`User not found`);
                });
            }),
            new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    logger.warn(`[ audioServices.js:EmoServiceStartRQ ] Channel 2 response timeout`);
                    resolve(null);
                }, 5000);

                //  고객 스트림큐 삭제
                connection1.query(`SELECT *
                FROM emo_user_info 
                WHERE userinfo_userid = ${userinfo_userId + 10}`, (err, results) => {
                    if(err) {
                        logger.error(`[ app.js:EmoServiceStopRQ ] ${err}`);
                        reject(err);
                    }

                    let ErkMsgHead_cus = currentErkApiMsg.create({
                        MsgType: 23,
                        TransactionId: results[0].userinfo_uuid,
                        QueueInfo: ErkQueueInfo2,
                        OrgId: results[0].org_id,
                        UserId: results[0].userinfo_userId + 10
                    });

                    let EmoServiceStopMsg_cus = currentErkApiMsg.create({
                        EmoServiceStopRQ: {
                            ErkMsgHead: ErkMsgHead_cus,
                            EmoRecogType: 1,    // 개인감성 or 사회감성
                            MsgTime: DateUtils.getCurrentTimestamp(),   // 년월일시분초밀리초
                            ServiceType: results[0].userinfo_serviceType,
                            PhysioEngine_ReceiveQueueName: "",
                            PhysioEngine_SendQueueName: "",
                            SpeechEngine_ReceiveQueueName: `${results[0].erkengineInfo_returnCustomer_recvQueueName}`,
                            SpeechEngine_SendQueueName: `${results[0].erkengineInfo_returnCustomer_sendQueueName}`,
                            FaceEngine_ReceiveQueueName: "",
                            FaceEngine_SendQueueName: "",
                            KnowledgeEngine_ReceiveQueueName: "",
                            KnowledgeEngine_SendQueueName: "",
                        }
                    });
                    let EmoServiceStopMsg_buf_cus = currentErkApiMsg.encode(EmoServiceStopMsg_cus).finish();
                    logger.info(`[ audioServices.js:EmoServiceStopRQ ] 생성된 EmoServiceStopRQ 메세지\n${JSON.stringify(EmoServiceStopMsg_cus, null, 4)}`);

                    let emoSerStop_send_rq = `UPDATE emo_user_info
                    SET erkEmoSrvcStop_send_dt = NOW(3)
                    WHERE userinfo_userId = ${results[0].userinfo_userId};`;
                    connection1.query(emoSerStop_send_rq, (err, results) => {
                        if (err) {
                            logger.error(`[ audioServices.js:EmoServiceStopRQ ] ${err}`);
                            reject(err);
                            return;
                        }

                        logger.info(`[ audioServices.js:EmoServiceStopRQ ] DB 업데이트 후 메세지 송신`);
                        ch2.sendToQueue("ERK_API_QUEUE", EmoServiceStopMsg_buf_cus);

                        resolve('success');
                    });
                });
            })
        ]);
    } catch (err) {
        logger.error(`[ audioServices.js:EmoServiceStopRQ ] ${err}`);         
        return {
            message: 'error',
            return_type: 0,
            error: err.message
        };
    }
}

//  GSM 파일 무결성 체크
async function checkGsm610WavFileIntegrity(filePath) {
    let fd;
    try {
        // 버퍼 생성 전 null/undefined 체크
        const headerBuffer = Buffer.alloc(44);
        const chunkBuffer = Buffer.alloc(8);

        // Buffer가 제대로 생성되었는지 확인
        fd = await fsp.open(filePath, 'r');

        // WAVE 헤더 검증
        const { bytesRead } = await fd.read(headerBuffer, 0, 44, 0);
        if (bytesRead !== 44) {
            throw new Error(`Failed to read header: only ${bytesRead} bytes read`);
        }
        
        // RIFF 검증
        const riffHeader = headerBuffer.slice(0, 4).toString('ascii');
        if (riffHeader !== 'RIFF') {
            throw new Error(`Invalid RIFF header: ${riffHeader}`);
        }
        
        // 파일 크기 검증 추가
        const fileSize = headerBuffer.readUInt32LE(4);
        if (fileSize <= 44) {
            throw new Error(`Invalid file size: ${fileSize}`);
        }
        
        // WAVE 포맷 검증
        const waveFormat = headerBuffer.slice(8, 12).toString('ascii');
        if (waveFormat !== 'WAVE') {
            throw new Error(`Invalid WAVE format: ${waveFormat}`);
        }
        
        // fmt 청크 검증
        const fmtChunk = headerBuffer.slice(12, 16).toString('ascii');
        if (fmtChunk !== 'fmt ') {
            throw new Error(`Invalid fmt chunk: ${fmtChunk}`);
        }
        
        // fmt 청크 크기 검증
        const fmtChunkSize = headerBuffer.readUInt32LE(16);
        if (isNaN(fmtChunkSize) || fmtChunkSize < 16) {
            throw new Error(`Invalid fmt chunk size: ${fmtChunkSize}`);
        }
        
        // GSM 6.10 포맷 검증
        const audioFormat = headerBuffer.readUInt16LE(20);
        if (audioFormat === 0x0031) {
            // 데이터 청크 찾기 및 검증
            let offset = 12 + fmtChunkSize + 8;
            let foundData = false;
            let headerLength = 0;
        
            while (offset < (await fd.stat()).size) {
                const chunkReadResult = await fd.read(chunkBuffer, 0, 8, offset);
                if (chunkReadResult.bytesRead !== 8) break;
                
                const chunkId = chunkBuffer.slice(0, 4).toString('ascii');
                const chunkSize = chunkBuffer.readUInt32LE(4);
                
                if (chunkId === 'data') {
                    // GSM 6.10 프레임 크기 검증
                    if (chunkSize % 65 !== 0) {
                        throw new Error(`Invalid data chunk size for GSM 6.10: ${chunkSize}`);
                    }
                    foundData = true;
                    headerLength = offset + 8;
                    break;
                }
                offset += 8 + chunkSize;
            }

            if (!foundData) { throw new Error('Data chunk not found'); }

            return {
                status: "valid",
                format: "GSM 6.10",
                audioFormat: "0x0031",
                gsmHeaderLength: headerLength,  // 헤더 전체 길이 반환
                dataOffset: headerLength     // 데이터 시작 위치도 함께 반환
            };
        } else if (audioFormat === 0x0001) { // 이미 PCM 포맷인 경우
            // 데이터 청크 찾기
            let offset = 12 + fmtChunkSize + 8;
            let foundData = false;
            let headerLength = 0;

            while (offset < (await fd.stat()).size) {
            const chunkReadResult = await fd.read(chunkBuffer, 0, 8, offset);
            if (chunkReadResult.bytesRead !== 8) break;

            const chunkId = chunkBuffer.slice(0, 4).toString('ascii');
            const chunkSize = chunkBuffer.readUInt32LE(4);

            if (chunkId === 'data') {
                foundData = true;
                headerLength = offset + 8;
                break;
            }
            offset += 8 + chunkSize;
            }

            if (!foundData) {
            throw new Error('Data chunk not found');
            }

            return {
                status: "valid",
                format: "PCM",
                audioFormat: "0x1",
                gsmHeaderLength: headerLength,
                dataOffset: headerLength
            };
        } else {
            throw new Error(`Unsupported audio format: 0x${audioFormat.toString(16)}`);
        }
    } catch (error) {
        throw new Error(error.message);
    } finally {
        if (fd) await fd.close();  // 파일 디스크립터 닫기 필수
    }
}

module.exports = {
    handleNewFile,
    EmoServiceStartRQ,
    EmoServiceStopRQ
};