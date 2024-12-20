'use strict'

const logger = require('../logs/logger');
const fs = require('fs');
const fsp = require('fs').promises;
const { EventEmitter } = require('events');

const path = require('path');
const { spawn } = require('child_process');

const DIRECTORIES = require('../config/directories');  // 디렉토리 설정 import 추가

//  WAV 파일 헤더 길이 찾기
async function findWavHeaderLength(filePath) {
    const MAX_HEADER_SIZE = 1024;   // 최대 헤더 크기를 1KB로 설정
    
    try {
        const fileHandle = await fsp.open(filePath, 'r');
        const buffer = Buffer.alloc(MAX_HEADER_SIZE);
        const { bytesRead } = await fileHandle.read(buffer, 0, MAX_HEADER_SIZE, 0);
        
        if (buffer.toString('ascii', 0, 4) !== 'RIFF') {
            throw new Error(`Not a valid WAV file: RIFF header not found in ${filePath}`);
        }
        
        const fileSize = buffer.readUInt32LE(4) + 8;
        const stat = await fileHandle.stat();
        const actualFileSize = stat.size;
        if (fileSize !== actualFileSize) {
            throw new Error(`File size mismatch in ${filePath}. Header says ${fileSize}, actual size is ${actualFileSize}`);
        }
        
        if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
            throw new Error(`Not a valid WAV file: WAVE format not found in ${filePath}`);
        }
        
        let offset = 12;
        let dataChunkFound = false;
        
        while (offset < bytesRead - 8) {
            const chunkId = buffer.toString('ascii', offset, offset + 4);
            const chunkSize = buffer.readUInt32LE(offset + 4);
            
            if (chunkId === 'fmt ') {
                const audioFormat = buffer.readUInt16LE(offset + 8);
                if (audioFormat !== 1) {
                    throw new Error(`Unsupported audio format: ${audioFormat} in ${filePath}`);
                }
                
                const numChannels = buffer.readUInt16LE(offset + 10);
                const sampleRate = buffer.readUInt32LE(offset + 12);
                const bitsPerSample = buffer.readUInt16LE(offset + 22);
                logger.info(`File: ${filePath}, Channels: ${numChannels}, Sample Rate: ${sampleRate}, Bits per Sample: ${bitsPerSample}`);
            } else if (chunkId === 'data') {
                dataChunkFound = true;
                logger.info(`Header length is ${offset + 8} bytes in ${filePath}`);
                await fileHandle.close();
                return { result: offset + 8, filePath };  // filePath도 함께 반환
            }
            
            offset += 8 + chunkSize;
        }
        
        await fileHandle.close();
        if (!dataChunkFound) {
            throw new Error(`Data chunk not found in ${filePath}`);
        }
    } catch (error) {
        logger.error(`Error reading WAV file ${filePath}:`, error);
        throw error;
    }
}

//  GSM 포맷 변환 시도
async function attemptConversion(filePath, chunkNumber) {
    return new Promise(async (resolve, reject) => {
        let localCopyPath = null;
        let outputFile = null;

        try {
            // PCM 출력 디렉토리 확인
            if (!fs.existsSync(DIRECTORIES.PCM_OUTPUT)) {
                await fsp.mkdir(DIRECTORIES.PCM_OUTPUT, { recursive: true });
                logger.info(`[ app.js:attemptConversion ] Created PCM output directory`);
            }
            
            // 이벤트가 발생한 파일명
            const fileName = path.basename(filePath);
            
            // PCM_OUTPUT 디렉토리 사용
            localCopyPath = path.join(DIRECTORIES.PCM_OUTPUT, fileName);
            
            // 출력 파일 경로 설정 (PCM WAV)
            // 청크 정보를 포함한 출력 파일명 생성
            const startTime = (chunkNumber - 1) * 3;
            const endTime = chunkNumber * 3;
            const chunkInfo = `_chunk${chunkNumber}_${startTime}-${endTime}sec`;
            outputFile = path.join(DIRECTORIES.PCM_OUTPUT, `${path.parse(fileName).name}${chunkInfo}_pcm.wav`);
            // outputFile = path.join(DIRECTORIES.PCM_OUTPUT, `${path.parse(fileName).name}_pcm.wav`);

            // 기존 파일 정리
            await Promise.all([
                fs.existsSync(localCopyPath) ? fsp.unlink(localCopyPath) : Promise.resolve(),
                fs.existsSync(outputFile) ? fsp.unlink(outputFile) : Promise.resolve()
            ]);

            // 원본 파일을 로컬에 복사
            await fsp.copyFile(filePath, localCopyPath);
            logger.info(`[ app.js:attemptConversion ] File copied to local directory: ${localCopyPath}`);

            // ffmpeg 명령어 실행
            const ffmpegProcess = spawn('ffmpeg', [
                '-y',   // 덮어쓰기 옵션(설정하지 않으면 직접 입력해줘야 함)
                '-i', localCopyPath,
                '-c:a', 'pcm_s16le',
                '-ar', '16000',
                '-ac', '1',
                outputFile
            ]);

            ffmpegProcess.stdout.on('data', (data) => {
                logger.info(`[ app.js:attemptConversion ] FFmpeg stdout: ${data}`);
            });

            ffmpegProcess.stderr.on('data', (data) => {
                logger.info(`[ app.js:attemptConversion ] FFmpeg stderr: ${data}`);
            });

            ffmpegProcess.on('close', async (code) => {
                try {
                    if (code === 0) {
                        await fsp.unlink(localCopyPath);
                        logger.info(`[ app.js:attemptConversion ] File converted and saved to: ${outputFile}`);
                        
                        resolve({
                            success: true,
                            inputFile: filePath,
                            outputFile: outputFile,
                            message: 'Conversion completed successfully!'
                        });
                    } else {
                        await Promise.all([
                            fsp.unlink(localCopyPath).catch(() => {}),
                            fs.existsSync(outputFile) ? fsp.unlink(outputFile).catch(() => {}) : Promise.resolve()
                        ]);
                        
                        reject(new Error(`[ app.js:attemptConversion ] FFmpeg process exited with code ${code}`));
                    }
                } catch (error) {
                    reject(error);
                }
            });
        } catch(err) {
            // 에러 발생 시 cleanup 시도
            if (localCopyPath || outputFile) {
                await Promise.all([
                    localCopyPath ? fsp.unlink(localCopyPath).catch(() => {}) : Promise.resolve(),
                    outputFile ? fsp.unlink(outputFile).catch(() => {}) : Promise.resolve()
                ]);
            }
            
            logger.error(`[ app.js:attemptConversion ] Streaming conversion error: ${err}`);
            reject(err);
        }
    });
}

//  GSM -> PCM 변환
async function convertGsmToPcm(inputFile) {
    const CONVERSION_TIMEOUT = 300000; // 5 minutes timeout
    logger.info(`[ app.js:convertGsmToPcm ] convertGsmToPcm 함수 호출`);
    
    return new Promise(async (resolve, reject) => {
        let timeoutId;
        const tempFiles = [];

        try {
            timeoutId = setTimeout(() => {
                reject(new Error('Conversion timeout'));
            }, CONVERSION_TIMEOUT);

            const progressEmitter = new EventEmitter();
            progressEmitter.on('progress', (progress) => { logger.info(`Conversion progress: ${progress}%`); });

            // CONVERTING 형식 변환
            const conversionResult = await attemptConversion(inputFile);
            if (conversionResult.message === 'Conversion completed successfully!') {
                logger.info(`[ app.js:attemptConversion ] attemptConversion 결과\n${JSON.stringify(conversionResult, null, 2)}`);

                clearTimeout(timeoutId);
                resolve({
                    outputFile: conversionResult.outputFile,
                    message: 'success'
                });
            } else {
                throw new Error('Conversion failed');
            }
        } catch (err) {
            clearTimeout(timeoutId);
            logger.error(`[ app.js:convertGsmToPcm ] Conversion Failed: ${err}`);
            reject(err);
        }
    });
}

module.exports = {
    findWavHeaderLength,
    convertGsmToPcm,
    attemptConversion
};