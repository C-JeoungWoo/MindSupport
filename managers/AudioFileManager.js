'use strict'
//  음성 파일의 청크 처리, GSM/PCM 변환, 메타데이터 관리를 담당하는 매니저
const DateUtils = require('../utils/dateUtils');

const logger = require('../logs/logger');
const { handleNewFile, EmoServiceStopRQ } = require('../services/audioServices');

//  DB 연결( 추후 모듈화로 코드 최적화 필요 )
const mysql = require('../db/maria')();
const mysql2 = require('../db/acrV4')();

const connection1 = mysql.pool();
const connection2 = mysql2.pool();

mysql.pool_check(connection1);
mysql2.pool_check(connection2);

//  파일 상태 관리 클래스
class AudioFileManager {
    //  구조체 선언
    constructor() {
        this.pendingFiles = new Map();   // 파일 처리 상태 관리
        this.callTracker = new Map();      // 통화별 rx/tx 상태 추적 추가
    }

    // 1. 파일 정보 및 사용자 정보 조회
    async getUserInfoFromFile(filePath) {
        try {
            const fileName = path.basename(filePath);
            const caller_id = fileName.split('_')[2].replace('.wav', '');

            const results = await new Promise((resolve, reject) => {
                connection1.query(`
                    SELECT ui.*, 
                        JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.org_id')) as user_orgid,
                        JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.userinfo_uuid')) as user_uuid
                    FROM emo_user_info ui
                    LEFT JOIN sessions s ON ui.login_id = JSON_UNQUOTE(JSON_EXTRACT(CONVERT(s.data USING utf8), '$.user.login_id'))
                    WHERE ui.userinfo_userId = (
                        SELECT rd.USER_ID 
                        FROM acr_v4.t_rec_data${DateUtils.getYearMonth()} rd 
                        WHERE rd.AGENT_TELNO = ?
                        AND DATE(rd.REC_START_DATETIME) = CURDATE()
                        ORDER BY rd.REC_START_DATETIME DESC
                        LIMIT 1
                    )
                `, [caller_id], (error, results) => {
                    if (error) reject(error);
                    resolve(results?.[0]);
                });
            });

            if (!results) {
                throw new Error(`[ AudioFileManager:getUserInfoFromFile ] No user found for caller_id: ${caller_id}`);
            }

            logger.info(`[ AudioFileManager:getUserInfoFromFile ] Found user info for ${fileName}`, results);
            return results;
        } catch (error) {
            logger.error(`[ AudioFileManager:getUserInfoFromFile ] Error: ${error}`);
            throw error;
        }
    }

    // 2. 파일 처리 시작 및 추적
    async trackFile(filePath) {
        try {
            const userInfo = await this.getUserInfoFromFile(filePath);
            const fileType = filePath.includes('_rx') ? 'rx' : 'tx';
            const callId = filePath.split('_')[2].replace('.wav', '');

            // 파일 상태 추적
            this.pendingFiles.set(filePath, {
                userId: userInfo.userinfo_userId,
                userInfo: userInfo,
                fileType: fileType,
                callId: callId,
                timestamp: Date.now(),
                retryCount: 0,
                status: 'pending'
            });

            // 통화 상태 추적
            if (!this.callTracker.has(callId)) {
                this.callTracker.set(callId, {
                    userId: userInfo.userinfo_userId,
                    rx: { status: 'pending' },
                    tx: { status: 'pending' }
                });
            }

            logger.info(`[ AudioFileManager:trackFile ] Started tracking ${filePath}`);
            return userInfo;
        } catch (error) {
            logger.error(`[ AudioFileManager:trackFile ] Failed to track ${filePath}: ${error}`);
            throw error;
        }
    }

    // 3. 녹취 상태 확인
    async checkRecordingStatus(filePath) {
        const fileInfo = this.pendingFiles.get(filePath);
        if (!fileInfo) return null;

        try {
            const results = await new Promise((resolve, reject) => {
                connection2.query(`
                    SELECT REC_END_DATETIME 
                    FROM acr_v4.t_rec_data${DateUtils.getYearMonth()}
                    WHERE AGENT_TELNO = ?
                    AND DATE(REC_START_DATETIME) = CURDATE()
                    ORDER BY REC_START_DATETIME DESC
                    LIMIT 1;
                `, [fileInfo.userInfo.caller_id], (error, results) => {
                    if (error) reject(error);
                    resolve(results[0]);
                });
            });
            return results;
        } catch (error) {
            logger.error(`[ AudioFileManager:checkRecordingStatus ] Error: ${error}`);
            throw error;
        }
    }

    // 4. 파일 재처리
    async reprocessFile(filePath, fileInfo) {
        try {
            if (fileInfo.retryCount >= 3) {
                logger.error(`[ AudioFileManager:reprocessFile ] Max retry exceeded: ${filePath}`);
                this.pendingFiles.delete(filePath);
                return;
            }

            const processResult = await handleNewFile(filePath, fileInfo.userInfo, {
                fileType: fileInfo.fileType
            });

            if (processResult === 'success') {
                this.pendingFiles.delete(filePath);
                logger.info(`[ AudioFileManager:reprocessFile ] Successfully processed: ${filePath}`);
            } else {
                fileInfo.retryCount++;
                fileInfo.lastRetry = Date.now();
                logger.warn(`[ AudioFileManager:reprocessFile ] Retry ${fileInfo.retryCount}/3: ${filePath}`);
            }
        } catch (error) {
            logger.error(`[ AudioFileManager:reprocessFile ] Error: ${error}`);
            fileInfo.retryCount++;
        }
    }

    // 5. 파일 처리 완료 표시
    markFileComplete(filePath) {
        if (this.pendingFiles.has(filePath)) {
            const fileInfo = this.pendingFiles.get(filePath);
            logger.info(`[ AudioFileManager:markFileComplete ] Completed: ${filePath}`);
            this.pendingFiles.delete(filePath);
        }
    }

    // 6. 병렬 처리를 위한 함수 (EnhancedFSWatcher.js에서 구현 - Promise All 사용)
    // async processChannelFiles(callId, files) {
    //     try {
    //         // 각 채널(rx/tx) 병렬 처리
    //         const results = await Promise.all(
    //             files.map(async file => {
    //                 try {
    //                     const userInfo = await this.getUserInfoFromFile(file.path);
    //                     const result = await this.processChannel(file.path, userInfo, {
    //                         fileType: file.type // 'rx' 또는 'tx'
    //                     });

    //                     return {
    //                         type: file.type,
    //                         path: file.path,
    //                         success: true,
    //                         result
    //                     };
    //                 } catch (error) {
    //                     logger.error(`[ AudioFileManager:processChannelFiles ] Error processing ${file.type}: ${error}`);
    //                     return {
    //                         type: file.type,
    //                         path: file.path,
    //                         success: false,
    //                         error: error.message
    //                     };
    //                 }
    //             })
    //         );

    //         return results;
    //     } catch (error) {
    //         logger.error(`[ AudioFileManager:processChannelFiles ] Error processing channels: ${error}`);
    //         throw error;
    //     }
    // }

    // 8. 단일 채널 처리
    // async processChannel(filePath, userInfo, options) {
    //     try {
    //         // 파일 추적 시작
    //         await this.trackFile(filePath);

    //         // handleNewFile 호출하여 실제 처리 수행
    //         const result = await handleNewFile(filePath, userInfo, options);
    //         if (result === 'success') { this.markFileComplete(filePath); }

    //         return result;
    //     } catch (error) {
    //         logger.error(`[ AudioFileManager:processChannel ] Error processing file ${filePath}: ${error}`);
    //         throw error;
    //     }
    // }

    // EmoServiceStop 처리 중앙화
    async handleServiceStop(userId) {
        try {
            const stopResult = await EmoServiceStopRQ(userId);
            
            if (stopResult === 'success') {
                logger.info(`[ AudioFileManager:handleServiceStop ] Service stopped successfully for user ${userId}`);
                return true;
            } else {
                logger.error(`[ AudioFileManager:handleServiceStop ] Failed to stop service: ${stopResult}`);
                return false;
            }
        } catch (error) {
            logger.error(`[ AudioFileManager:handleServiceStop ] Error stopping service: ${error}`);
            throw error;
        }
    }

    // 파일 처리 완료 핸들러 수정
    async handleProcessingComplete(filePath, userId) {
        try {
            const fileInfo = this.pendingFiles.get(filePath);
            if (!fileInfo) {
                throw new Error(`No pending file info found for ${filePath}`);
            }

            const callId = filePath.split('_')[2].replace('.wav', '');

            const callInfo = this.callTracker.get(callId);
            if (!callInfo) {
                throw new Error(`No call info found for ${callId}`);
            }

            // 현재 파일 타입의 상태를 완료로 변경
            callInfo[fileInfo.fileType].status = 'completed';

            // rx와 tx 모두 완료된 경우에만 EmoServiceStop 호출
            if (callInfo.rx.status === 'completed' && callInfo.tx.status === 'completed') {
                await this.handleServiceStop(userId);
                this.callTracker.delete(callId);  // 통화 추적 정보 삭제
            }

            this.markFileComplete(filePath);
            return true;
        } catch (error) {
            logger.error(`[ AudioFileManager:handleProcessingComplete ] Error completing process: ${error}`);
            return false;
        }
    }
}

module.exports = AudioFileManager;