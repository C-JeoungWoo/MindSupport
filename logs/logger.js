'use strict'

const appRoot                          = require('app-root-path');
const winston                           = require('winston')
require('winston-daily-rotate-file')
const moment                          = require('moment-timezone');

// 기본 타임존을 한국으로 설정
moment.tz.setDefault('Asia/Seoul');

const logDir = `${__dirname}/log`;

// 로그 레벨
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
}

// 환경에 따른 로그 레벨 설정
const level = () => {
    const env = process.env.NODE_ENV || 'development'
    const isDevelopment = env === 'development'
    return isDevelopment ? 'debug' : 'warn'
}

// 로그 색상 정의
const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'blue',
}

winston.addColors(colors);

// 한국 시간 포맷터
const timezoneFormatter = winston.format((info) => {
    info.timestamp = moment().format('YYYY-MM-DD HH:mm:ss.SSS');
    return info;
});

// 로그 레벨에 따른 패딩 계산 함수
const getLevelPadding = (level) => {
    // ANSI 색상 코드를 제거하고 순수 레벨 텍스트만 추출
    const plainLevel = level.replace(/\u001b\[\d+m/g, '');
    
    switch (plainLevel.toLowerCase()) {
        case 'error': return ' ';
        case 'warn':  return ' ';
        case 'info':  return ' ';
        case 'http':  return ' ';
        case 'debug': return ' ';
        default:      return ' ';
    }
};

// 로그 포맷 정의
const format = winston.format.combine(
    timezoneFormatter(),
    winston.format.colorize({ all: true }),
    winston.format.printf((info) => {
        const padding = getLevelPadding(info.level);
        return `${info.timestamp} [${info.level}]${padding}${info.message}`;
    })
);

// 로그 관련
const logger = winston.createLogger({
    levels,
    format,
    level: level(),
    transports: [
        //  일반 로그 파일
        new winston.transports.DailyRotateFile({
            level: 'info',
            datePattern: 'YYMMDD_HH',
            dirname: logDir,
            filename: `%DATE%.log`,
            zippedArchive: true,	
            handleExceptions: true,
            maxFiles: 30,  // 30일치
            format: winston.format.combine(
                timezoneFormatter(),
                winston.format.uncolorize(),
                winston.format.printf((info) => {
                    const padding = {
                        error: ' ',
                        warn: '  ',
                        info: '  ',
                        http: '  ',
                        debug: ' '
                    };
                    return `${info.timestamp} [${info.level}]${padding[info.level.toLowerCase()]}${info.message}`;
                })
            )
        }),
        //  에러 로그 파일
        new winston.transports.DailyRotateFile({
            level: 'error',
            datePattern: 'YYMMDD_HH',
            dirname: logDir + '/error',  
            filename: `%DATE%_error.log`,
            zippedArchive: true,
            maxFiles: 30,
            format: winston.format.combine(
                timezoneFormatter(),
                winston.format.uncolorize(),
                winston.format.printf((info) => {
                    return `${info.timestamp} [${info.level}] ${info.message}`;
                })
            )
        }),
        new winston.transports.Console({
            handleExceptions: true,
        })
    ]
});

module.exports = logger;