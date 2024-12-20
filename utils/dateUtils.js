'use strict'

const logger = require('../logs/logger');
const moment = require('moment');

class DateUtils {
    //  기본 날짜 포맷 함수
    static getYearMonth() {
        let date = new Date();

        // 년
        let year = date.getFullYear().toString();

        // 월(1~9월은 앞에 0)
        let month = date.getMonth() + 1;
        month = month < 10 ? '0' + month.toString() : month.toString();

        return year + month;
    }

    static getYearMonthDay() {
        let date = new Date();
    
        // 년
        let year = date.getFullYear().toString();
    
        // 월(1~9월은 앞에 0)
        let month = date.getMonth() + 1;
        month = month < 10 ? '0' + month.toString() : month.toString();
    
        // 일(1~9일은 앞에 0)
        let day = date.getDate();
        day = day < 10 ? '0' + day.toString() : day.toString();
    
        return year + month + day;
    }

    //  년월일시분초
    static getCurrentDate() {
        let date = new Date();

        let year  = date.getFullYear().toString();
        let month = date.getMonth() + 1;
        month = month < 10 ? '0' + month.toString() : month.toString();
        let day   = date.getDate();
        day   = day < 10 ? '0' + day.toString() : day.toString();

        let hours   = date.getHours();
        hours   = hours < 10 ? '0' + hours.toString() : hours.toString();
        let minutes = date.getMinutes();
        minutes = minutes < 10 ? '0' + minutes.toString() : minutes.toString();
        let seconds = date.getSeconds();
        seconds = seconds < 10 ? '0' + seconds.toString() : seconds.toString();

        return year + "년 " + month + "월 " + day + "일 " + hours + "시 " + minutes + "분 " +  seconds + "초";
    }

    //  KST타임 날짜변환
    static getYearMonthDayHoursMinutes(date) {
        let regdate = new Date(date);
        // 각 부분(년, 월, 일, 시, 분)을 추출
        let year = regdate.getFullYear();
        let month = regdate.getMonth() + 1; // getMonth()는 0부터 시작하므로 +1
        let day = regdate.getDate();
        let hours = regdate.getHours();
        let minutes = regdate.getMinutes();

        // 포맷에 맞게 조정 (월과 일이 한 자리 숫자일 경우 앞에 0을 붙임)
        month = (month < 10) ? '0' + month : month;
        day = (day < 10) ? '0' + day : day;
        hours = (hours < 10) ? '0' + hours : hours;
        minutes = (minutes < 10) ? '0' + minutes : minutes;

        // 포맷된 문자열 반환
        return `${year}년 ${month}월 ${day}일 ${hours}시 ${minutes}분`;
    }

    //  msgTimeStamp 에 적용할 현재시간 구하기
    static getCurrentTimestamp() {
        //  밀리초 단위 timestamp (숫자로 반환)
        // return moment().valueOf();
        return Date.now();
    }

    // DATETIME(3) 형식의 문자열을 반환 ( 유닉스 시간 변환 )
    static getServerTimezone() {

        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    }

    static getCurrentDateTimeString(time) {
        let momentDate;
        let serverTimezone = DateUtils.getServerTimezone();
    
        if (time === undefined) {
            momentDate = moment().tz(serverTimezone);
        } else if (typeof time === 'string' && /^\d+$/.test(time)) {
            let parsedTime = parseInt(time);
            let currentTime = moment().tz(serverTimezone);
            let timeDiff = Math.abs(currentTime.diff(moment(parsedTime), 'years'));
    
            if (timeDiff > 10) {
                logger.warn(`[ app.js:getCurrentDateTimeString ] Abnormal timestamp detected: ${time}. Using current time instead.`);
                momentDate = currentTime;
            } else {
                // Unix 타임스탬프를 밀리초 단위로 처리
                momentDate = moment(parsedTime).tz(serverTimezone);
            }
        } else {
            // 다른 형식의 시간 입력 처리
            momentDate = moment.tz(time, serverTimezone);
        }
    
        if (!momentDate.isValid()) {
            logger.error(`[ app.js:getCurrentDateTimeString ] Invalid date provided: ${time}`);
            return 'Invalid Date';
        }

        return momentDate.format('YYYY-MM-DD HH:mm:ss.SSS');
    }
}

module.exports = DateUtils;