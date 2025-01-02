'use strict'
// app.js: 미들웨어 (node module 로딩, 변수 초기화, 오브젝트 선언 및 라우팅)의 중앙 통제 역할
const express = require('express');
const app = express();

const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');

const https = require('https');
const path = require(`path`);
const fs = require('fs');
const fsp = require('fs').promises;

const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, 'rmq.env') });
const protobuf = require(`protobufjs`);

const mysql = require('./db/maria')();//maria.js 연결
const mysql2 = require('./db/acrV4')();//acr_v4.js 연결

const connection = mysql.init(); //ETRI_EMOTION
const connection2 = mysql2.init(); //acr_v4

mysql.db_open(connection); // DB 연결
mysql2.db_open(connection2);

const logger = require(`./logs/logger`);
const amqp = require(`amqplib/callback_api`);

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const sharedSession = require(`express-socket.io-session`);
const moment = require('moment');
const cron = require('node-cron');

// 1. 설정 및 유틸리티
const DIRECTORIES = require('./config/directories');
const DateUtils = require('./utils/dateUtils');
const { setErkApiMsg, getErkApiMsg } = require('./utils/erkUtils');

// 2. 서비스 모듈
const audioServices = require('./services/audioServices');
const StreamingService = require('./services/streamingService');  // audioServices로 잘못 import 되어 있던 부분 수정

// 3. 매니저 모듈
const EnhancedFSWatcher = require('./managers/EnhancedFSWatcher');
const { QueueManager } = require('./managers/QueueManager');  // 경로 수정
const { StreamProcessor } = require('./managers/StreamProcessor');  // 경로 수정

//  app.set - express 설정, 값 저장
app.set('view engine', 'ejs');
app.set('views', './views');

//  app.use - 모든 경우 적용
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(`public`));

//  자체 서명 인증서 가져오기 & HTTPS 에이전트 설정(인증서 비활성화)
const https_options = {
    key: fs.readFileSync(path.resolve(__dirname, `./selfsigned.key`)),
    cert: fs.readFileSync(path.resolve(__dirname, `./selfsigned.crt`))
}

// HTTP 서버 연결(다온빌딩 → 본사(8888))
const PORT = process.env.PORT || 8888;
const httpsServer = https.createServer(https_options, app);
const HTTPServer = httpsServer.listen(PORT, () => {
    const address = HTTPServer.address();
    logger.info(`[ httpServer ] ${JSON.stringify(address)}`);

    HTTPServer.once('close', () => {
        connectionManagers.forEach(connectionManager => connectionManager.close());
    });
});

//  WebSocket 설정
const socketIo = require(`socket.io`);
const { router } = require('websocket');
const { resolve } = require('app-root-path');
const io = socketIo(httpsServer, {
    path: `/socket.io`,
    transport: [`websocket`]
});
let sessionUser = {};   // 사용자 정보 저장 변수
let loginIDs = 0;   // 처음 사용자 수 초기화
let loginIDsArr = new Map();    // Map 객체로 고유하게 접속자 관리

// MySQL Session store
const MySQLoptions = {
    host: "192.168.0.29",
    port: 3306,
    user: "root",
    password: "spdlqj21",
    database: "ETRI_EMOTION" 
}
const MySQLoptions_sessionStore = new MySQLStore(MySQLoptions);

app.use(
    session({
        key: "session_cookie_name",
        secret: '@#@$MYSIGN#@$#$',
        resave: false, // 세션을 언제나 저장할지 설정함
        saveUninitialized: false, // 세션이 저장되기 전 uninitialized 상태로 미리 만들어 저장
        cookie: {
            secure: true,
            maxAge: 6 * 60 * 60 * 1000 
        }, // HTTPS 사용시에만 `secure` 설정 true
        store : MySQLoptions_sessionStore
    })
);

io.use(sharedSession(
    session({
        key: "session_cookie_name",
        secret: '@#@$MYSIGN#@$#$',
        resave: false, // 세션을 언제나 저장할지 설정함
        saveUninitialized: false, // 세션이 저장되기 전 uninitialized 상태로 미리 만들어 저장
        cookie: {
            secure: true,
            maxAge: 6 * 60 * 60 * 1000 
        }, // HTTPS 사용시에만 `secure` 설정 true
        store : MySQLoptions_sessionStore
    }), {
        autoSave: true
}));

//////////////////////////////////////////////// [공통] ////////////////////////////////////////////////

//  기본 페이지 
app.get('/', (req, res) => {
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/ ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.render(`login`, { title: `MindSupport 로그인` });
    } else {
        if(req.session.user.group_manager === 'Y') {
            res.redirect(`/workStatusMain`)
        } else {
            res.redirect('/consultant')
        }
    }
});

//  현재 경로 세션에 저장
app.post('/saveCurrentPath', (req, res) => {
    const path = req.body.path;

    //  현재 세션이 유지중이라면
    if (req.session) {
        sessionUser.current_path = path;
        logger.info(`[ app.js:/saveCurrentPath ] 현재 경로 저장: ${sessionUser.current_path}`)
        
        res.status(200).send({ message: 'Path saved successfully' });
    } else {
        res.status(500).send({ message: 'Failed to save path' });
    }
});

//////////////////////////////////////////////// [상담원] ////////////////////////////////////////////////

//  상담원 페이지
app.get(`/consultant`, async (req, res) => {
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/consultant ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `로그인` });
    }
    let send_userinfo_id = req.session.user.userinfo_userId;

    //  현재 경로 세션에 저장
    sessionUser.current_path = '/consultant';

    try{
        //  통화 이력 표출
        let call_history_etri_query = `SELECT
            agent_telno,
            group_type
        FROM ETRI_EMOTION.emo_user_info
        WHERE login_id = "${req.session.user.login_id}"`;

        let call_history_acr_query = `SELECT
            AGENT_TELNO,
            TARGET_TELNO,
            DATE_FORMAT(STR_TO_DATE(CONCAT(rec_start_Date, ' ', rec_start_Time), '%Y-%m-%d %H:%i:%s'), '%Y-%m-%d %H:%i:%s') AS REC_START_DATETIME,
            DATE_FORMAT(REC_END_DATETIME, '%Y-%m-%d %H:%i:%s') as REC_END_DATETIME,
            REC_DURATION,
            MEMO
        FROM acr_v4.t_rec_data${DateUtils.getYearMonth()};`;

        //  마지막으로 전달받은 감성 표출
        let emotion_type = `SELECT emotion_type FROM ETRI_EMOTION.emo_emotion_info
        WHERE userinfo_userId = ${send_userinfo_id} ORDER BY send_dt DESC LIMIT 1;`
        

        // 두 데이터베이스에서 데이터를 가져오기
        const etriPromise = new Promise((resolve, reject) => {
            connection.query(call_history_etri_query, (err, results) => {
                if (err) {
                    logger.error(`[ app.js:etriEmotionQuery ] ${err}`);
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });

        const acrPromise = new Promise((resolve, reject) => {
            connection2.query(call_history_acr_query, (err, results) => {
                if (err) {
                    logger.error(`[ app.js:acrQuery ] ${err}`);
                    
                    logger.error('2');
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });

        // 결과 병합
        const [etriResults, acrResults] = await Promise.all([etriPromise, acrPromise]);

        const call_history_agent = etriResults.map(etri => {
            const acrData = acrResults.find(acr =>
                acr.AGENT_TELNO === etri.agent_telno) || {};
            return {
                ...etri,
                ...acrData,
            };
        });

        console.log('call_history_query : ', call_history_agent);

        connection.query(emotion_type, (err, results) => {
            if (err) {
                logger.error(`[ app.js:/consultant_connection ] ${err}`);
            }
            
            let call_emotion_agent = results;

                res.render('consultant', {
                    title:`MindSupport 업무화면`, 
                    call_history_agent: call_history_agent || {},
                    call_emotion_agent: call_emotion_agent,
                    session_name: req.session.user.user_name
                }, (err, html) => {
                    if (err) {
                        logger.error(`[ app.js:/consultant ] Error rendering body: ${err}`);
                        res.status(500).send('Error rendering body');
            
                        return;
                    }

                    res.send(html);
                });
        });
    } catch (err) {
        logger.error(`[ app.js:/consultant ] Error: ${err}`);
        res.status(500).send('Internal Server Error');
    }
});

//  상담원 통화이력 조회
app.get('/consultant/call_history', (req, res) => {
    let send_agentID = req.session.user.login_id;
    let get_call_history = `SELECT 
        TARGET_TELNO,
        group_type,
        STR_TO_DATE(CONCAT(rec_start_Date, ' ', rec_start_Time) AS REC_START_DATETIME, 
        REC_END_DATETIME,
        SEC_TO_TIME(TIMESTAMPDIFF(second, connect_dt, disconnect_dt)) AS call_time,
        MEMO
    FROM t_rec_data${DateUtils.getYearMonth()} WHERE login_id = ${send_agentID} 
    AND REC_START_DATETIME > DATE_FORMAT(NOW(3), '%Y-%m-%d')
    ORDER BY REC_START_DATETIME DESC LIMIT 5;`;

    //상담사 상담 이력 표
    connection.query(get_call_history, (err, results) => {
        if (err) {
            logger.error(`[ app.js:callHistory ] ${err}`);
            connection.end();
        }

        res.send(results);
    });
});

//////////////////////////////////////////////// [관리자] ////////////////////////////////////////////////

//  근무현황
app.get('/workStatusMain', async (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/workStatusMain ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `MindSupport 로그인` });

        return;
    }

    // 현재 경로 세션에 저장
    sessionUser.current_path = '/workStatusMain';
    logger.info(`[ app.js:/workStatusMain ] 현재 경로: ${sessionUser.current_path}`);

    try {
        //  감성코칭이 필요한 상담사(수동코칭 설정했으나 못 보낸 상담사)
        let need_coach = `SELECT
            ecm.auto_seq,
            DATE_FORMAT(ecm.call_date, '%Y-%m-%d') as call_date,
            CONCAT(
                IFNULL(LEFT(ecm.call_time, 2), '00'), ':',
                CASE 
                    WHEN IFNULL(SUBSTRING(ecm.call_time, 3, 2), '00') <= '30' THEN '00' 
                    ELSE '30' 
                END, '~',
                CASE
                    WHEN IFNULL(SUBSTRING(ecm.call_time, 3, 2), '00') <= '30' 
                    THEN IFNULL(LEFT(ecm.call_time, 2), '00')
                    ELSE LPAD(MOD(CAST(IFNULL(LEFT(ecm.call_time, 2), '00') AS UNSIGNED) + 1, 24), 2, '0')
                END, ':',
                CASE 
                    WHEN IFNULL(SUBSTRING(ecm.call_time, 3, 2), '00') <= '30' THEN '30' 
                    ELSE '00' 
                END
            ) AS time_range,
            ecm.call_time,
            ecm.login_id,
            (SELECT MAX(ui.user_name) FROM emo_user_info ui WHERE ui.login_id = ecm.login_id) AS user_name,
            ecm.auto_over_anger,
            ecm.agent_anger,
            ecm.auto_over_sad,
            ecm.agent_sad,
            ecm.auto_standard,
            COUNT(DISTINCT ecc.call_time) AS call_count,
            ecm.auto_coach,
            ecm.send_yn 
        FROM 
            ETRI_EMOTION.emo_coaching_message ecm
        LEFT JOIN ETRI_EMOTION.emo_call_count ecc
        ON ecm.call_date = ecc.call_date
            AND ecm.login_id = ecc.login_id
            AND ecc.call_time >= CONCAT(LEFT(ecm.call_time, 2), 
                CASE WHEN SUBSTRING(ecm.call_time, 3, 2) <= '30' THEN '0000' ELSE '3000' END)
            AND ecc.call_time < CONCAT(
                CASE 
                    WHEN SUBSTRING(ecm.call_time, 3, 2) <= '30' THEN LEFT(ecm.call_time, 2)
                    ELSE LPAD(MOD(CAST(LEFT(ecm.call_time, 2) AS UNSIGNED) + 1, 24), 2, '0')
                END,
                CASE WHEN SUBSTRING(ecm.call_time, 3, 2) <= '30' THEN '3000' ELSE '0000' END
            )
        WHERE ecm.call_date = ?
        AND ecm.auto_coach = 'P'
        AND ecm.send_yn = 'N'
        GROUP BY 
            ecm.call_date, ecm.call_time,
            ecm.login_id, ecm.auto_standard,
            ecm.agent_sad, ecm.agent_anger
        ORDER BY 
            ecm.call_date, ecm.call_time, ecm.login_id;`;
        logger.info(`[ app.js:workStatusMain ] need_coach\n${need_coach}`);

        //  현재 근무중인 상담원( 현재 접속중이며 테이블에 있는 감성데이터 중 마지막 감성)
        // ETRI_EMOTION DB 쿼리
        let etriEmotionQuery = `
            SELECT 
                s.session_id,
                JSON_UNQUOTE(JSON_EXTRACT(s.data, '$.user.user_name')) AS session_user_name,
                e.userinfo_userid,
                e.login_id,
                e.user_name AS emo_user_name,
                e.group_manager,
                e.loginout_dt AS last_login_time,
                Latest_Emo.emotion_type
            FROM
                ETRI_EMOTION.sessions s
            JOIN 
                ETRI_EMOTION.emo_loginout_info e 
                ON JSON_UNQUOTE(JSON_EXTRACT(s.data, '$.user.user_name')) = e.user_name
            JOIN 
                (
                    SELECT 
                        user_name, 
                        MAX(loginout_dt) AS max_login_dt
                    FROM 
                        ETRI_EMOTION.emo_loginout_info
                    WHERE 
                        loginout_type = 'I'
                    GROUP BY 
                        user_name
                ) latest_login 
                ON e.user_name = latest_login.user_name 
                AND e.loginout_dt = latest_login.max_login_dt
            JOIN 
                (
                    SELECT 
                        emotion_type, 
                        userinfo_userid, 
                        login_id 
                    FROM 
                        (
                            SELECT 
                                emotion_type, 
                                userinfo_userid, 
                                login_id,
                                ROW_NUMBER() OVER (PARTITION BY login_id ORDER BY send_dt DESC) AS rn
                            FROM 
                                ETRI_EMOTION.emo_emotion_info
                        ) ranked
                    WHERE 
                        rn = 1
                ) Latest_Emo 
                ON e.login_id = Latest_Emo.login_id
            WHERE 
                JSON_EXTRACT(s.data, '$.user') IS NOT NULL
                AND s.expires > UNIX_TIMESTAMP()
                AND e.loginout_type = 'I'
                AND e.group_manager = 'N';`;

        let acrQuery = `
            SELECT AGENT_ID, REC_END_DATETIME
            FROM (
                SELECT 
                    AGENT_ID, 
                    REC_END_DATETIME,
                    ROW_NUMBER() OVER (PARTITION BY AGENT_ID ORDER BY REC_START_TIME DESC) AS rn
                FROM 
                    acr_v4.t_rec_data${DateUtils.getYearMonth()}
            ) ranked_calls
            WHERE rn = 1;`;

        //  비접속 상담원
        let notPresent_agent = `SELECT eui.user_name, eui.login_id
        FROM emo_user_info eui
        WHERE eui.user_name NOT IN (
            SELECT JSON_UNQUOTE(JSON_EXTRACT(data, '$.user.user_name')) as user_name
            FROM sessions
            WHERE expires > UNIX_TIMESTAMP()
            AND JSON_EXTRACT(data, '$.user') IS NOT NULL
            AND JSON_EXTRACT(data, '$.user.group_manager') = 'N'
        )
        AND eui.group_manager = 'N'
        AND eui.user_type != '3'
        ORDER BY eui.user_name;`;
        logger.info(`[ app.js:workStatusMain ] notPresent_agent\n${notPresent_agent}`);  

        // 두 데이터베이스에서 데이터를 가져오기
        const etriPromise = new Promise((resolve, reject) => {
            connection.query(etriEmotionQuery, (err, results) => {
                if (err) {
                    logger.error(`[ app.js:etriEmotionQuery ] ${err}`);
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });

        const acrPromise = new Promise((resolve, reject) => {
            connection2.query(acrQuery, (err, results) => {
                if (err) {
                    logger.error(`[ app.js:acrQuery ] ${err}`);
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });

        // 결과 병합
        const [etriResults, acrResults] = await Promise.all([etriPromise, acrPromise]);

        const present_agent = etriResults.map(etri => {
            const acrData = acrResults.find(acr => acr.AGENT_ID === etri.login_id) || {};
            return {
                ...etri,
                last_call_status: acrData.REC_END_DATETIME ? 1 : 0
            };
        });

        connection.query(need_coach, [DateUtils.getYearMonthDay()], (err, needed_coaching) => {
            if (err) throw err;

            connection.query(notPresent_agent, (err, notPresentAgentResults) => {
                if (err) throw err;

                //비동기 처리를 위한 데이터만 필요할 경우
                if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
                    return res.json({
                        needed_coaching: needed_coaching,
                        present_agent: present_agent,
                        notPresent_agent: notPresentAgentResults,
                    });
                }

                res.render('index', {
                    title: 'MindSupport 근무현황',
                    body: 'workStatusMain',
                    needed_coaching: needed_coaching,
                    session_name: req.session.user.user_name,
                    present_agent: present_agent,
                    notPresent_agent: notPresent_agent
                }, (err, html) => {
                    if (err) {
                        logger.error(`[ app.js:/workStatusMain ] Error rendering body: ${err}`);
                        return res.status(500).send('Error rendering body');
                    }
                    res.send(html);
                });
            });
        });
    } catch (err) {
        logger.error(`[ app.js:/workStatusMain ] Error: ${err}`);
        res.status(500).send('Internal Server Error');
    }
});

//  코칭이 필요한 상담원 수동코칭
app.post('/workStatusMain/sendMsg', (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:workStatusMain/sendMsg ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `로그인` });
    }

    try {
        let testChk = req.body;
        logger.info(`[ app.js:workStatusMain/sendMsg ] 전달받은 조건\n${JSON.stringify(testChk, null, 2)}`);

        // 코칭 메세지, 특이사항, 코칭 기준시간
        let coach_msg = req.body.getMsgDetail;
        let coach_standard = req.body.getAutoStandard;
        let coach_name = req.body.getAgentName;
        let coach_loginId = req.body.getLoginId;
        
        //  세션 정보가 담긴 map 객체에서 조회
        if (loginIDsArr.has(coach_loginId)) {
            const value = loginIDsArr.get(coach_loginId);
            logger.info(`[ app.js:/workStatusMain/sendMsg ] 코칭 할 상담원: ${value.id}, ${value.user}`);
            logger.info(`[ app.js:/workStatusMain/sendMsg ] 기준 시간 : ${coach_standard}초`);
            logger.info(`[ app.js:/workStatusMain/sendMsg ] 수동 코칭 메세지 내용\n${coach_msg}`);

            try {
                let upt_pass_query = `UPDATE emo_coaching_message 
                SET send_yn = 'Y',
                    send_dt = NOW(3),
                    auto_detail = '${coach_msg}'
                WHERE login_id = '${value.id}'
                    AND call_time = '${req.body.getCallTime}'
                    AND auto_seq = ${req.body.getAutoSeq}
                    AND agent_anger = ${req.body.getAgentAngry}
                    AND agent_sad = ${req.body.getAgentSad}
                    AND auto_standard = '${coach_standard}'
                    AND call_date >= DATE_FORMAT('${DateUtils.getYearMonthDay()}', '%Y-%m-%d') 
                    AND auto_coach = 'P';`;

                logger.info(upt_pass_query)

                connection.query(upt_pass_query, (err, results) => {
                    if (err) {
                        logger.error(`[ app.js:/workStatusMain/sendMsg ] ${err}`);
                        connection.end();
                    }

                    // 소켓을 통해 메세지 전송
                    io.to(value.socket).emit('admin_msg', ` ──────────────── [관리자 메세지] ────────────────
** ${value.user}님! 관리자로부터 메세지가 도착했습니다. **
" ${coach_msg} "        ${DateUtils.getCurrentDate()}
────────────────────────────────────────`);

                    res.status(200).send({ message: `success`});
                });
            } catch(err) {
                logger.error(`[ app.js:/workStatusMain/sendMsg ] 웹소켓 메세지 전송 오류`);
                res.status(500).send({ message: `오류 발생`});
            }
        } else {
            logger.warn(`[ app.js:/workStatusMain/sendMsg ] 해당 상담원은 접속 중 아님`);

            res.status(200).send({ message: `notOnline`});
        }
    } catch(err) {
        logger.error(`[ app.js:workStatusMain/sendMsg ] API 오류 ${err}`);
        res.status(500).send({ message: `오류 발생`});
    }
});

    //  특정 상담원 상세 근무현황
app.post('/workStatusMain/getTodayEmo', async (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:workStatusMain/getTodayEmo ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `로그인` });
    }

    try {
        const getTodayEmo_loginId = req.body.loginId;

        //  1. 금일 감성 갯수
        
        //ETRI_EMOITON today 감성 조회 쿼리
        const getTodayEmo_etri_today_qry = `
        SELECT 
            eei.login_id,
            eei.emotion_type,
            eui.agent_telno,
            COUNT(*) as today_count
        FROM ETRI_EMOTION.emo_emotion_info eei
        LEFT JOIN ETRI_EMOTION.emo_user_info eui
        ON eui.login_id = eei.login_id
        WHERE eei.send_dt >= CURDATE()
        AND eei.login_id = '${getTodayEmo_loginId}'
        GROUP BY eei.emotion_type;`;

        console.log('getTodayEmo_etri_today_qry : ',getTodayEmo_etri_today_qry);

        //acr_v4 today 감성 조회 쿼리 위의 쿼리랑 병합해야 함
        const getTodayEmo_acr_today_qry = `
        SELECT
            *
        FROM
            acr_v4.t_rec_data202501
        WHERE REC_START_DATE >= STR_TO_DATE(CONCAT(DATE_FORMAT(CURDATE(), '%Y%m%d'), ' 00:00:00.000'), '%Y%m%d %H:%i:%s.%f');`

        console.log('getTodayEmo_acr_today_qry : ',getTodayEmo_acr_today_qry);

        //ETRI_EMOITON yesterday 감성 조회 쿼리
        const getTodayEmo_etri_yesterday_qry = `
        SELECT 
            eei.login_id,
            eei.emotion_type,
            eui.agent_telno,
            COUNT(*) as yesterday_count
        FROM ETRI_EMOTION.emo_emotion_info eei
        LEFT JOIN ETRI_EMOTION.emo_user_info eui
        ON eui.login_id = eei.login_id
        WHERE eei.login_id = '${getTodayEmo_loginId}'
        GROUP BY eei.emotion_type;`;

        //acr_v4 yesterday 감성 조회 쿼리 위의 쿼리랑 병합해야 함
        const getTodayEmo_acr_yesterday_qry = `
        SELECT
            *
        FROM
            acr_v4.t_rec_data202501
        WHERE REC_START_DATE >= STR_TO_DATE(CONCAT(DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 DAY), '%Y%m%d'), ' 00:00:00.000'), '%Y%m%d %H:%i:%s.%f')
        AND REC_START_DATE < STR_TO_DATE(CONCAT(DATE_FORMAT(CURDATE(), '%Y%m%d'), ' 00:00:00.000'), '%Y%m%d %H:%i:%s.%f')`;

        //최종적으로 위의 today와 yesterday 로 병합된 2개의 쿼리를 얘랑 또 병합해서 데이터를 조회해야함
        // const getTodayEmo_qry = `
        // `;


        // const getTodayEmo_acr_qry = `
        // `;

        //  2. 금일 감성 흐름
        //   - 고객 감성 데이터 가져오기
        const customData = `SELECT 
            TIME(send_dt) as send_dt,
            emotion_type,
            file_seq,
            cusEmoType as client,
            emotion_type as worker,
            accuracy
        FROM 
            ETRI_EMOTION.emo_emotion_info
        WHERE 
            DATE(send_dt) = CURDATE()  -- 현재 날짜의 데이터만 선택
            AND send_dt BETWEEN CURDATE() + INTERVAL 9 HOUR 
            AND CURDATE() + INTERVAL 18 HOUR  -- 9시부터 18시까지의 데이터
            AND login_id = '${getTodayEmo_loginId}'
        ORDER BY 
            file_seq, send_dt;`;
        
        //   - 통화 상태 데이터 가져오기
        const callRecords = `SELECT
            REC_START_TIME AS call_start,
            TIME(REC_END_DATETIME) AS call_end,
            TIMESTAMPDIFF(SECOND, REC_START_TIME, REC_END_DATETIME) AS duration
        FROM acr_v4.t_rec_data${DateUtils.getYearMonth()}
        WHERE REC_START_DATE = CURDATE()
        AND DATE(REC_END_DATETIME) = CURDATE()
        AND AGENT_ID = '${getTodayEmo_loginId}'
        ORDER BY call_start;`;
        
        //   - 상담원 감성 데이터 가져오기(추후엔 구분해서 데이터 뿌리기)
        const counselData = '';

        //  3. 통화 이력 데이터

        ////////////////////////////////////////////////////////today START
        const etriPromise = new Promise((resolve, reject) => {
            connection.query(getTodayEmo_etri_today_qry, (err, results) => {
                if (err) {
                    logger.error(`[ app.js:etriEmotionQuery ] ${err}`);
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });

        const acrPromise = new Promise((resolve, reject) => {
            connection2.query(getTodayEmo_acr_today_qry, (err, results) => {
                if (err) {
                    logger.error(`[ app.js:acrQuery ] ${err}`);
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });

        // 결과 병합
        const [etriResults, acrResults] = await Promise.all([etriPromise, acrPromise]);
        ////////////////////////////////////////////////////////today END

        ////////////////////////////////////////////////////////yesterday START
        const etriPromise2 = new Promise((resolve, reject) => {
            connection.query(getTodayEmo_etri_yesterday_qry, (err, results) => {
                if (err) {
                    logger.error(`[ app.js:etriEmotionQuery ] ${err}`);
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });

        const acrPromise2 = new Promise((resolve, reject) => {
            connection2.query(getTodayEmo_acr_yesterday_qry, (err, results) => {
                if (err) {
                    logger.error(`[ app.js:acrQuery ] ${err}`);
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });

        // 결과 병합
        const [etriResults2, acrResults2] = await Promise.all([etriPromise2, acrPromise2]);
        ////////////////////////////////////////////////////////yesterday END

        const getTodayEmo_today = etriResults.map(etri => {
            const acrData = acrResults.find(acr => etri.agent_telno === acr.AGENT_TELNO) || {};
            return {
                ...etri,
                ...acrData,
            };
        });
        console.log(getTodayEmo_today);
        console.log('===============================================');

        const getTodayEmo_yesterday = etriResults2.map(etri => {
            const acrData = acrResults2.find(acr => etri.agent_telno === acr.AGENT_TELNO) || {};
            return {
                ...etri,
                ...acrData,
            };
        });
        console.log(getTodayEmo_yesterday);

        connection.query(getTodayEmo_etri_yesterday_qry+customData, (err, results) => {
            if (err) {
                logger.error(`[ app.js:/workStatusMain/getTodayEmo ] ${err}`);
                throw err;
            }
            connection2.query(callRecords, (err,callRecordsresults) => {
                if (err) throw err;

                //  데이터 전송
                const data = results[0];
                const cus_results2 = results[1];
                const call_results3 = callRecordsresults;

                res.status(200).json({
                    data:data,
                    customData:cus_results2,    // 고객 데이터
                    callRecords:call_results3,  // 통화 데이터
                    counselData:counselData // 상담원 데이터
                });
            });
        });
    } catch (err) {
        console.error(`[ app.js:getTodayEmo ] 데이터 가져오기 오류: ${err}`);
        res.status(500).json({ message:'[ app.js:getTodayEmo ] 서버 오류' });
    };
});

//  특정 상담원 통화이력
app.post('/workStatusMain/getTodayEmo/getCallHistory', (req, res) => {
    try {
        // 세션 체크
        if (!req.session || !req.session.authenticate || !req.session.user) {
            logger.info(`[ app.js:workStatusMain/getTodayEmo ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
            return res.status(401).json({ message: "인증 필요" });
        }
        const receivedData = req.body;
        let filename1= '';
        if (receivedData.length > 1) {  // 길이가 2개 이상 [ 상세 통화 이력 조회 ]
            filename1 = receivedData[1];
            logger.info(`[ app.js:workStatusMain/getTodayEmo ] 1\n${JSON.stringify(filename1)}`);
        } else {    // 정지 버튼 눌렀을때 [ 단일 문자열로 통화 이력 데이터 재요청 ]
            filename1 = receivedData.getCallId;
            logger.info(`[ app.js:workStatusMain/getTodayEmo ] 2\n${JSON.stringify(filename1)}`);
        }

        //   - 고객 감성 데이터 가져오기
        const customData = `SELECT
            file_name,
            TIME(send_dt) as send_dt,
            emotion_type,
            file_seq,
            cusEmoType as client,
            emotion_type as worker,
            accuracy
        FROM 
            ETRI_EMOTION.emo_emotion_info
        WHERE 
            file_name = '${filename1}.wav'
            AND DATE(send_dt) = CURDATE() 
            AND send_dt BETWEEN CURDATE() + INTERVAL 9 HOUR 
            AND CURDATE() + INTERVAL 18 HOUR;`;
        logger.info(`[ app.js:workStatusMain/getTodayEmo/getCallHistory ] ${customData}`)
        
        connection.query(customData, (err, results) => {
            if (err) {
                logger.error(`[ app.js:workStatusMain/getTodayEmo/getCallHistory ] ${err}`);
                throw err;
            }

            let data = results;
            logger.info(`[ app.js:workStatusMain/getTodayEmo/getCallHistory ] ${results.length}건 조회`);

            res.status(200).json({ data: data });
        });
    } catch(err) {
        logger.error(`[ app.js:workStatusMain/getTodayEmo/getCallHistory ] API 오류 ${err}`);
        res.status(500).json({ message: "오류 발생" });
    }
});

//  코칭현황
app.get('/coachingMain', async (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/coachingMain ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `MindSupport 로그인` });
    }
    
    // 현재 경로 세션에 저장
    sessionUser.current_path = '/coachingMain';
    logger.info(`[ app.js:/coachingMain ] 현재 경로: ${sessionUser.current_path}`);

    try{
        // 금일 코칭 흐름 조회 쿼리
        let coaching_flow_query = `
        SELECT
            ecm.call_date,
            LEFT(LPAD(call_time, 6, '0'), 2) AS call_hour,
            COUNT(*) AS count_per_hour,
            SUM(CASE WHEN ecm.auto_coach = "P" THEN 1 ELSE 0 END) AS auto_coach_count,
            SUM(CASE WHEN ecm.auto_coach != "P" THEN 1 ELSE 0 END) AS manual_coach_count
        FROM
            ETRI_EMOTION.emo_coaching_message ecm
        WHERE
            ecm.call_date = CURDATE()
        GROUP BY
            call_hour
        ORDER BY
            ecm.call_date desc,
            call_hour asc,
            ecm.insert_dt desc;`

        // 금일 코칭 현황 조회 쿼리
        let coaching_type_chart_query = `
            SELECT
                SUM(CASE WHEN ecm.auto_coach = "P" THEN 1 ELSE 0 END) AS auto_coach_count,
                SUM(CASE WHEN ecm.auto_coach != "P" THEN 1 ELSE 0 END) AS manual_coach_count
            FROM
                ETRI_EMOTION.emo_coaching_message ecm
            WHERE
                ecm.call_date = CURDATE();`

        // 통화 및 코칭 현황 자동 및 수동 코칭 조회 쿼리
            let coaching_status_query = `
            SELECT
                SUM(CASE WHEN ecm.auto_coach = "P" THEN 1 ELSE 0 END) AS auto_coach_count,
                SUM(CASE WHEN ecm.auto_coach != "P" THEN 1 ELSE 0 END) AS manual_coach_count
            FROM
                ETRI_EMOTION.emo_coaching_message ecm
            WHERE
                ecm.call_date = CURDATE();`

        // 통화 및 코칭 현황 통화시간 및 건수 조회 쿼리
            let coaching_call_time_count_query = `
            SELECT
                CONCAT(FLOOR(trd.REC_DURATION / 60), ' 분 ', trd.REC_DURATION % 60, ' 초') AS sum_call_time,
                CONCAT(COUNT(*), ' 건') as sum_call_count
            FROM
                acr_v4.t_rec_data${DateUtils.getYearMonth()} trd
            WHERE
                trd.REC_START_DATE = CURDATE();`

        // 최근 1시간 코칭 이력 조회 쿼리
        let coaching_hrs_history_query = `
            SELECT
                ecm.call_date,
                ecm.call_time,
                ecm.login_id,
                ecm.auto_detail,
                DATE_FORMAT(ecm.insert_dt, '%Y-%m-%d %H:%i') AS insert_formatted_dt,
                eui.user_name,
                eui.group_type
            FROM
                ETRI_EMOTION.emo_coaching_message ecm
            LEFT JOIN
                ETRI_EMOTION.emo_user_info eui
            ON
                eui.login_id = ecm.login_id
            ORDER BY
                ecm.call_date desc,
                ecm.call_time desc,
                ecm.insert_dt desc
            LIMIT 5;`

        connection.query(coaching_flow_query + coaching_type_chart_query + coaching_status_query + coaching_hrs_history_query, (err,results) => {
            if (err){
                logger.warn(`[] app.js:coaching_main_connection1 ${err}`);
            }

            let coaching_flow = results[0];
            let coaching_type_chart = results[1];
            let coaching_call_status = results[2];
            let coaching_hrs_history = results[3];

                connection2.query(coaching_call_time_count_query, (err, results) => {
                    if (err){
                        logger.warn(`[] app.js:coaching_main_connection2 ${err}`);
                    }

                    res.render('index', {
                        title: 'MindSupport 상세통계',
                        body: 'coachingMain',
                        session_id: req.session.user.user_name,
                        coaching_flow: coaching_flow,
                        coaching_type_chart: coaching_type_chart[0],
                        coaching_call_status: coaching_call_status,
                        coaching_calltimecount: results[0],
                        coaching_hrs_history: coaching_hrs_history
                    }, (err, html) => {
                        if (err) {
                            logger.error(`[ app.js:/coachingMain ] Error rendering body: ${err}`);
                            res.status(500).send('Error rendering body');
                            
                            return;
                        } else{
                        }
                
                        res.send(html);
                    });
            });
        });
    } catch (error){
        logger.error('Error saving data:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

//  감성현황
app.get('/emotionStatus', async (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/emotionStatus ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `MindSupport 로그인` });
    }

    // 현재 경로 세션에 저장
    sessionUser.current_path = '/emotionStatus';
    logger.info(`[ app.js:/emotionStatus ] 현재 경로: ${sessionUser.current_path}`);

    try {
        //  (현재 근무중인 상담원 수 / 전체 상담원 수)
        //      현재 근무자 수 (상담관리자 제외)
        let query1 =`SELECT COUNT(*) AS logged_user FROM sessions s 
        WHERE JSON_EXTRACT(s.data, '$.user.group_manager') = 'N';`;
        logger.info(`[ app.js:/emotionStatus ] 현재 근무자 수\n${query1}`);

        //      총 근무자 수 (상담관리자 제외)
        let query2 = `SELECT COUNT(*) AS tot_user
        FROM emo_user_info
        WHERE emo_user_info.group_manager != 'Y';`;
        logger.info(`[ app.js:/emotionStatus ] 총 근무자 수\n${query2}`);

        //  금일 감정의 개수 (근무자 전체)
        let query3 = `WITH today_data AS (
        SELECT 
            eei.login_id,
            eei.emotion_type,
            COUNT(*) as today_count
        FROM emo_emotion_info eei
        INNER JOIN acr_v4.t_rec_data${DateUtils.getYearMonth()} trd
        ON eei.file_name = trd.REC_FILENAME
        WHERE trd.REC_START_DATE >= STR_TO_DATE(CONCAT(DATE_FORMAT(CURDATE(), '%Y%m%d'), ' 00:00:00.000'), '%Y%m%d %H:%i:%s.%f')
        AND eei.send_dt >= CURDATE()
        GROUP BY eei.emotion_type
        ),
        yesterday_data AS (
            SELECT 
                eei.login_id,
                eei.emotion_type,
                COUNT(*) as yesterday_count
            FROM emo_emotion_info eei
            INNER JOIN acr_v4.t_rec_data${DateUtils.getYearMonth()} trd
            ON eei.file_name = trd.REC_FILENAME
            WHERE trd.REC_START_DATE >= STR_TO_DATE(CONCAT(DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 DAY), '%Y%m%d'), ' 00:00:00.000'), '%Y%m%d %H:%i:%s.%f')
            AND trd.REC_START_DATE < STR_TO_DATE(CONCAT(DATE_FORMAT(CURDATE(), '%Y%m%d'), ' 00:00:00.000'), '%Y%m%d %H:%i:%s.%f')
            GROUP BY eei.emotion_type
        )
        SELECT 
            t.login_id,
            t.emotion_type,
            t.today_count,
            COALESCE(y.yesterday_count, 0) as yesterday_count,
            t.today_count - COALESCE(y.yesterday_count, 0) as count_change
        FROM today_data t
        LEFT JOIN yesterday_data y
        ON t.emotion_type = y.emotion_type
        UNION
        SELECT 
            y.login_id,
            y.emotion_type,
            0 as today_count,
            y.yesterday_count,
            0 - y.yesterday_count as count_change
        FROM yesterday_data y
        WHERE y.emotion_type NOT IN (SELECT emotion_type FROM today_data)
        ORDER BY emotion_type;`;
        logger.info(`[ app.js:/emotionStatus ] 금일 감정 개수\n${query3}`);

        // 1시간 단위 감성 상태 추이
        let query4 = `SELECT
            HOUR(send_dt) as hour,
            emotion_type,
            COUNT(*) count
        FROM emo_emotion_info
        WHERE send_dt >= DATE_FORMAT(NOW(3),'%Y-%m-%d')
        GROUP BY emotion_type, HOUR;`;
        logger.info(`[ app.js:/emotionStatus ] 시간 별 감성 상태\n${query4}`);

        //  금일 누적 부정 감성횟수
        let query5 = `SELECT
            eei.login_id,
            eui.user_name,
            COUNT(*) AS total_emotion_count,
            SUM(CASE WHEN eei.emotion_type IN ('6', '7') THEN 1 ELSE 0 END) AS negative_emotion_count
        FROM emo_emotion_info eei
        INNER JOIN emo_user_info eui ON eei.login_id = eui.login_id
        WHERE DATE(send_dt) = CURDATE()
        GROUP BY eei.login_id, eui.user_name
        HAVING negative_emotion_count > 0
        ORDER BY negative_emotion_count DESC
        LIMIT 5;`;
        logger.info(`[ app.js:/emotionStatus ] 금일 누적 부정 감성\n${query5}`);

        //  금일 개인 상담 건수
        let query6 = `SELECT
            trd.AGENT_ID,
            eui.user_name,
            COUNT(*) AS RECORD_COUNT
        FROM acr_v4.t_rec_data${DateUtils.getYearMonth()} trd
        LEFT JOIN ETRI_EMOTION.emo_user_info eui
            ON trd.AGENT_ID = eui.login_id 
        WHERE trd.REC_START_DATE >= CURDATE() 
        AND trd.REC_START_DATE < CURDATE() + 1
        GROUP BY AGENT_ID
        ORDER BY RECORD_COUNT DESC
        LIMIT 5;`;
        logger.info(`[ app.js:/emotionStatus ] 금일 개인 상담 건수\n${query6}`);

        // 상담 그룹 별 감정 건수
        let query7 = `SELECT
            A.group_type,
            C.emotion_type,
            IFNULL(COUNT(*), 0) as count
        FROM emo_user_info as A
        INNER JOIN acr_v4.t_rec_data${DateUtils.getYearMonth()} AS B 
        ON B.AGENT_ID = A.login_id 
        INNER JOIN emo_emotion_info AS C
        ON C.file_name = B.REC_FILENAME 
        WHERE STR_TO_DATE(CONCAT(B.REC_START_DATE, ' ', B.REC_START_TIME), '%Y-%m-%d %H:%i:%s') >= DATE_FORMAT(NOW(3),'%Y-%m-%d')
        AND C.send_dt >= CURDATE() 
        GROUP BY A.group_type, C.emotion_type
        ORDER BY A.group_type, C.emotion_type;`;
        logger.info(`[ app.js:/emotionStatus ] 상담 그룹 별 감정 건수\n${query7}`);

        //  직급 or MBTI or 나이 등등 별 감성 건수
        let query8=`SELECT 
            CASE 
                WHEN A.age BETWEEN 20 AND 29 THEN '20대'
                WHEN A.age BETWEEN 30 AND 39 THEN '30대'
                WHEN A.age BETWEEN 40 AND 49 THEN '40대'
                WHEN A.age BETWEEN 50 AND 59 THEN '50대'
                WHEN A.age >= 60 THEN '60대 이상'
                ELSE '기타'
            END AS age_group,
            C.emotion_type,
            IFNULL(COUNT(*), 0) as count
        FROM emo_user_info as A
        INNER JOIN acr_v4.t_rec_data${DateUtils.getYearMonth()} AS B 
            ON B.AGENT_ID = A.login_id
        INNER JOIN emo_emotion_info AS C
            ON C.file_name = B.REC_FILENAME
        WHERE STR_TO_DATE(CONCAT(B.REC_START_DATE, ' ', B.REC_START_TIME), '%Y-%m-%d %H:%i:%s') >= DATE_FORMAT(NOW(3),'%Y-%m-%d')
            AND C.send_dt >= CURDATE()
        GROUP BY 
            CASE 
                WHEN A.age BETWEEN 20 AND 29 THEN '20대'
                WHEN A.age BETWEEN 30 AND 39 THEN '30대'
                WHEN A.age BETWEEN 40 AND 49 THEN '40대'
                WHEN A.age BETWEEN 50 AND 59 THEN '50대'
                WHEN A.age >= 60 THEN '60대 이상'
                ELSE '기타'
            END,
            C.emotion_type
        ORDER BY 
            CASE 
                WHEN age_group = '20대' THEN 1
                WHEN age_group = '30대' THEN 2
                WHEN age_group = '40대' THEN 3
                WHEN age_group = '50대' THEN 4
                WHEN age_group = '60대 이상' THEN 5
                ELSE 6
            END,
            C.emotion_type;`;
        logger.info(`[ app.js:/emotionStatus ] 상담 그룹 별 감정 건수\n${query8}`);

        connection.query(query1+query2+query3+query4+query5+query6+query7+query8, (err, results) => {
            if (err) {
                logger.error(`[ app.js:emotionStatusQry ] ${err}`);
                return;
            }

            //  결과 값들은 배열에 삽입됨
            let result_nowCount = results[0];   // query1
            let result_totGroup = results[1];   // query2
            let result_todayEmo = results[2];   // query3
            let result_hourEmo = results[3];    // ...
            let result_negativeCount = results[4];  // ...
            let result_todayCallCount = results[5]; // ...
            let result_todayGroupCount = results[6];    // ...
            let result_todayAgeCount = results[7];  // ...
    
            res.render('index', {
                title: 'MindSupport 감성현황',
                body: 'emotionStatus',
                session_id: req.session.user.user_name,
                result_nowCount: result_nowCount,
                result_totGroup: result_totGroup,
                result_todayEmo: result_todayEmo,
                result_hourEmo: result_hourEmo,
                result_negativeCount: result_negativeCount,
                result_todayCallCount: result_todayCallCount,
                result_todayGroupCount: result_todayGroupCount,
                result_todayAgeCount: result_todayAgeCount
            }, (err, html) => {
                if (err) {
                    logger.error(`[ app.js:/emotionStatus ] Error rendering body: ${err}`);
                    res.status(500).send('Error rendering body');
                    
                    return;
                }
                
                res.status(200).send(html);
            });
        });
    } catch (err) {
        logger.error(`[ app.js:/emotionStatus ] ${err}`);
        res.status(500).send('서버 오류 발생.');
    }
});

//  코칭이력
app.get(`/coachingHistory`, (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/coachingHistory ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `MindSupport 로그인` });
    }

    // 현재 경로 세션에 저장
    sessionUser.current_path = '/coachingHistory';
    logger.info(`[ app.js:/coachingHistory ] 현재 경로: ${sessionUser.current_path}`);
    
    //  금일 코칭이력 기준
    //   - 조건1 : 상담원만
    //   - 조건2 : 코칭 메세지 전송 이력이 있는지
    //   - 조건3 : 현재 날짜 기준으로 존재 하는지  
    const counsel_history_sql = `SELECT
        DATE_FORMAT(b.call_date, '%Y-%m-%d') as call_date,
        a.login_id ,
        a.user_name ,
        b.auto_coach,
        b.auto_standard,
        b.auto_detail,
        b.pass_etc
    FROM emo_user_info a
    LEFT JOIN emo_coaching_message b
    ON b.login_id = a.login_id
    WHERE b.send_yn = 'Y'
    AND b.call_date = CURDATE();`;

    let select_user_info_query = `
        SELECT user_name,
        login_id
        FROM emo_user_info
        WHERE group_manager != 'Y' 
        AND user_type != 3;`

    logger.info(`[ app.js:coachingHistory ] ${counsel_history_sql}`)

    connection.query(counsel_history_sql + select_user_info_query, (err, results) => {
        if(err) {
            logger.error(`[ app.js:/coachingHistory ] ${err}`);
            connection.end();
        }

        let counsel_history = results[0];
        let counsel_history_user_info = results[1];

        res.render('index', { 
            title: 'MindSupport 코칭이력',
            body: 'coachingHistory',
            counsel_history : counsel_history,
            counsel_history_user_info: counsel_history_user_info,
            session_id: req.session.user.user_name
        }, (err, html) => {
            if (err) {
                logger.error(`[ app.js:/coachingHistory ] Error rendering body: ${err}`);
                res.status(500).send('[ app.js:/coachingHistory ] Error rendering body');
                
                return;
            }

            res.send(html);
        });
    });
});

//  코칭이력 검색
app.post(`/datingHistory`, (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:datingHistory ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `로그인` });
    }
    let jsonData = req.query;
    logger.info(`[ app.js:datingHistory ] 등록 요청 데이터\n${JSON.stringify(jsonData, null, 2)}`);

    //  시작일
    let dating_start = jsonData.getStartDate;
    //  종료일
    let dating_end = jsonData.getEndDate.trim();
    //  상담원 ID
    let getLoginId_parse = jsonData.getLoginId.trim();
    //  상담원 이름
    let getUserName_parse = jsonData.getUserName.trim();

    //  코칭이력 조회
    //   - 조건1 : ID, 이름 입력 못받았을 때
    //   - 조건2 : ID만 입력 받았을 때
    //   - 조건3 : 이름만 입력 받았을 때
    let search_history_sql;
    if(getLoginId_parse === '' && getUserName_parse === '') {
        search_history_sql = `SELECT
            DATE_FORMAT(b.call_date, '%Y-%m-%d') as call_date,
            a.login_id ,
            a.user_name ,
            b.auto_coach,
            b.auto_standard,
            b.auto_detail,
            b.pass_etc
        FROM emo_user_info a
        LEFT JOIN emo_coaching_message b
        ON b.login_id = a.login_id
        WHERE b.send_yn = 'Y'
        AND b.call_date BETWEEN STR_TO_DATE('${dating_start}', '%Y%m%d') AND STR_TO_DATE('${dating_end}', '%Y%m%d');`;
    } else if (getLoginId_parse === '') {
        search_history_sql = `SELECT
            DATE_FORMAT(b.call_date, '%Y-%m-%d') as call_date,
            a.login_id ,
            a.user_name ,
            b.auto_coach,
            b.auto_standard,
            b.auto_detail,
            b.pass_etc
        FROM emo_user_info a
        LEFT JOIN emo_coaching_message b
        ON b.login_id = a.login_id
        WHERE a.user_name = '${getUserName_parse}'
        AND b.send_yn = 'Y'
        AND b.call_date BETWEEN STR_TO_DATE('${dating_start}', '%Y%m%d') AND STR_TO_DATE('${dating_end}', '%Y%m%d');`;
    } else if (getUserName_parse === '') {
        search_history_sql = `SELECT
            DATE_FORMAT(b.call_date, '%Y-%m-%d') as call_date,
            a.login_id ,
            a.user_name ,
            b.auto_coach,
            b.auto_standard,
            b.auto_detail,
            b.pass_etc
        FROM emo_user_info a
        LEFT JOIN emo_coaching_message b
        ON b.login_id = a.login_id
        WHERE a.login_id = '${getLoginId_parse}'
        AND b.send_yn = 'Y'
        AND b.call_date BETWEEN STR_TO_DATE('${dating_start}', '%Y%m%d') AND STR_TO_DATE('${dating_end}', '%Y%m%d');`;
    } else {
        search_history_sql = `SELECT
            DATE_FORMAT(b.call_date, '%Y-%m-%d') as call_date,
            a.login_id ,
            a.user_name ,
            b.auto_coach,
            b.auto_standard,
            b.auto_detail,
            b.pass_etc
        FROM emo_user_info a
        LEFT JOIN emo_coaching_message b
        ON b.login_id = a.login_id
        WHERE a.login_id = '${getLoginId_parse}'
        AND a.user_name = '${getUserName_parse}'
        AND b.send_yn = 'Y'
        AND b.call_date BETWEEN STR_TO_DATE('${dating_start}', '%Y%m%d') AND STR_TO_DATE('${dating_end}', '%Y%m%d');`;
    }

    connection.query(search_history_sql, (err, results) => {
        if(err) {
            logger.error(`[ app.js:/datingHistory ] ${err}`);
            connection.end();
        }

        if(results.length > 0) {
            // for(let i=0; results.length; i++) {
            //     results[i]['call_date'] = results[i]['call_date'].slice(0, 10);
            // }

            logger.warn(results['call_date'])
        }
        
        let counsel_history = results;
        res.send(counsel_history);
    });
});

//  코칭조건 설정
app.get('/coachingSetting', (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/coachingSetting ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `MindSupport 로그인` });
    }

    // 현재 경로 세션에 저장
    sessionUser.current_path = '/coachingSetting';
    logger.info(`[ app.js:/coachingSetting ] 현재 경로: ${sessionUser.current_path}`);

    let coach_set_qry = `SELECT
        auto_seq,
        use_unuse ,
        standard ,
        over_anger ,
        over_sad ,
        auto_coach ,
        auto_detail,
        del_yn 
    FROM emo_counsel_con
    WHERE del_yn != 'Y'`;

    connection.query(coach_set_qry, (err, results) => {
        if (err) {
            logger.error(`[ app.js:coach_set_qry ] ${err}`);
            connection.end();
        }

        let coach_set = results;

        res.render('index', {
            title: 'MindSupport 코칭조건 설정',
            body: 'coachingSetting',
            coach_set: coach_set,
            session_id: req.session.user.user_name
        }, (err, html) => {
            if (err) {
                logger.error(`[ app.js:/coachingSetting ] Error rendering body: ${err}`);
                res.status(500).send('[ app.js:/coachingSetting ] Error rendering body');
                
                return;
            }

            res.send(html);
        });
    });
});

//  코칭조건 등록
app.post(`/settingCoachSubmit`, (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:settingCoachSubmit ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        
        return res.status(401).json({ error: '인증되지 않은 사용자입니다.' });
    }
    logger.info(`[ app.js:settingCoachSubmit ] ${req.body}`);

    // 데이터 유효성 검사
    if (!req.body.getUseUnuse || !req.body.getStandard || !req.body.getOverAnger || !req.body.getOverSad || !req.body.getAutoCoach || !req.body.getAutoDetail) {
        return res.status(400).json({ error: '모든 필드를 입력해주세요.' });
    }

    if(req.body.getUseUnuse === '사용안함') {
        req.body.getUseUnuse = 'N';
    } else {
        req.body.getUseUnuse = 'Y';
    }

    let standardValue = req.body.getStandard.toString();
    req.body.getStandard = standardValue.substring(0, 2);
    req.body.getOverAnger = Number(req.body.getOverAnger);
    req.body.getOverSad = Number(req.body.getOverSad);

    if(req.body.getAutoCoach === '수동') {
        req.body.getAutoCoach = 'P';
    } else {
        req.body.getAutoCoach = 'A';
    }

    try {
        // 데이터베이스 저장 로직
        const query = `INSERT INTO emo_counsel_con (use_unuse, standard, over_anger, over_sad, auto_coach, auto_detail, auto_insert_dt, del_yn)
        VALUES ('${req.body.getUseUnuse}', ${req.body.getStandard}, ${req.body.getOverAnger}, ${req.body.getOverSad}, '${req.body.getAutoCoach}', '${req.body.getAutoDetail}', NOW(3), 'N')`;

        logger.info(`[ settingCoachSubmit:query ] ${query}`)
        connection.query(query, (err, results) => {
            if (err) {
                logger.error(`[ settingCoachSubmit:query ] ${err}`);
                throw err;
            }

            // 성공 응답
            res.status(200).json({ message: '데이터가 성공적으로 저장되었습니다.' });
        });
    } catch (error) {
        logger.error('Error saving data:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

//  코칭조건 수정
app.post('/updatingCoachSet', (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:updatingCoachSet ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `로그인` });
    }
    let { jsonData } = req.body;
    logger.info(`[ app.js:updatingCoachSet ] 사용자 정보 수정 요청 ${JSON.stringify(jsonData, null, 4)}`);

    try {
        // 데이터베이스 저장 로직
        let upt_query = `UPDATE emo_counsel_con
        SET use_unuse = '${jsonData.getUseUnuse}',
            standard = ${parseInt(jsonData.getStandard.replace("초", ""), 10)},
            over_anger = ${jsonData.getOverAnger},
            over_sad = ${jsonData.getOverSad},
            auto_coach = '${jsonData.getAutoCoach}', 
            auto_detail = '${jsonData.getAutoDetail}',
            auto_update_dt = NOW(3)
        WHERE auto_seq = ${jsonData.getAutoSeq};`
        logger.info(`[ app.js:updatingCoachSet ] ${upt_query}`);

        connection.query(upt_query, (err, results) => {
            if (err) {
                logger.error(`[ app.js:updatingCoachSet ] ${err}`);
                connection.end();
            }

            logger.info(`[ app.js:updatingCoachSet ] ${results}`);

            // 성공 응답
            res.status(200).send({ message: '성공적으로 수정되었습니다.' });
        });
    } catch (error) {
        logger.error('Error saving data:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

//  코칭조건 삭제
app.post(`/deletingCoachSet`, (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:deletingCoachSet ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `로그인` });
    }
    const { data } = req.body;
    logger.info(`[ app.js:deletingCoachSet ] 받은 조건 번호: ${data}`);
    
    let del_coach_qry= `UPDATE emo_counsel_con 
    SET del_yn = 'Y', use_unuse = 'N', auto_update_dt = NOW(3)
    WHERE auto_seq IN (${data})`;
    logger.info(`[ app.js:deletingCoachSet ] ${del_coach_qry}`);

    connection.query(del_coach_qry, (err, results) => {
        if (err) {
            logger.error(`[ app.js:del_coach_qry ] ${err}`);
            connection.end();
        }

        res.status(200).send({ message: '성공적으로 삭제되었습니다.' });
    });
});

//  관리자 코칭
app.get(`/coachingAdmin`, (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/coachingAdmin ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `MindSupport 로그인` });
    }

    const coachingData = req.session?.coachingData || {};

    // 현재 경로 세션에 저장
    sessionUser.current_path = '/coachingAdmin';
    logger.info(`[ app.js:/coachingAdmin ] 현재 경로: ${sessionUser.current_path}`);

    try {
        let select_user_qry = `SELECT
            login_id,
            user_name
        FROM ETRI_EMOTION.emo_user_info
        WHERE group_manager != 'Y'
        AND user_type != 3;`

        //  금일 기준 코칭 대상자 표시
        let coachingAdmin_qry = `SELECT
        ecm.auto_seq,
        DATE_FORMAT(ecm.call_date, '%Y-%m-%d') AS call_date,
        CONCAT(
            LEFT(ecm.call_time, 2), ':',                                -- 시간 부분 (HH)
            SUBSTRING(ecm.call_time, 3, 2), ':',                        -- 분 부분 (mm)
            LPAD(CAST(SUBSTRING(ecm.call_time, 5, 2) AS UNSIGNED) DIV 10 * 10, 2, '0'),
            '~',
            LEFT(ecm.call_time, 2), ':',                                -- 시간 부분 (HH)
            CASE 
                WHEN SUBSTRING(ecm.call_time, 5, 2) >= '50' THEN 
                    LPAD(CAST(SUBSTRING(ecm.call_time, 3, 2) AS UNSIGNED) + 1, 2, '0')
                ELSE 
                    SUBSTRING(ecm.call_time, 3, 2) 
            END, ':',
            LPAD((CAST(SUBSTRING(ecm.call_time, 5, 2) AS UNSIGNED) DIV 10 * 10 + 10) % 60, 2, '0')
        ) AS time_range,
        ecm.call_time,
        ecm.login_id,
        (SELECT MAX(ui.user_name) FROM emo_user_info ui WHERE ui.login_id = ecm.login_id) AS user_name,
        (SELECT MAX(ui.group_type) FROM emo_user_info ui WHERE ui.login_id = ecm.login_id) AS group_type,
        ecm.agent_anger,
        ecm.auto_over_anger,
        ecm.agent_sad,
        ecm.auto_over_sad,
        COUNT(DISTINCT eei.send_dt) AS call_count,
        ecm.auto_coach
    FROM
        ETRI_EMOTION.emo_coaching_message ecm
    LEFT JOIN
        ETRI_EMOTION.emo_emotion_info eei ON
        ecm.call_date = DATE(eei.send_dt)
        AND ecm.login_id = eei.login_id
        AND eei.send_dt >= STR_TO_DATE(CONCAT(DATE_FORMAT(ecm.call_date, '%Y-%m-%d'), ' ',
            LEFT(ecm.call_time, 2), ':',
            SUBSTRING(ecm.call_time, 3, 2), ':',
            LPAD(CAST(SUBSTRING(ecm.call_time, 5, 2) AS UNSIGNED) DIV 10 * 10, 2, '0')
            ), '%Y-%m-%d %H:%i:%s')
        AND eei.send_dt < STR_TO_DATE(CONCAT(DATE_FORMAT(ecm.call_date, '%Y-%m-%d'), ' ',
            LEFT(ecm.call_time, 2), ':',
            CASE 
                WHEN SUBSTRING(ecm.call_time, 5, 2) >= '50' THEN 
                    LPAD(CAST(SUBSTRING(ecm.call_time, 3, 2) AS UNSIGNED) + 1, 2, '0') 
                ELSE 
                    SUBSTRING(ecm.call_time, 3, 2) 
            END, ':',
            LPAD((CAST(SUBSTRING(ecm.call_time, 5, 2) AS UNSIGNED) DIV 10 * 10 + 10) % 60, 2, '0')
            ), '%Y-%m-%d %H:%i:%s')
    WHERE ecm.call_date = '${DateUtils.getYearMonthDay()}'
        AND ecm.auto_coach = 'P'
        AND (ecm.agent_anger >= ecm.auto_over_anger OR ecm.agent_sad >= ecm.auto_over_sad)
        AND send_yn = 'N'
    GROUP BY
        ecm.call_date, ecm.call_time,
        ecm.login_id, ecm.auto_standard,
        ecm.agent_sad, ecm.agent_anger,
        ecm.auto_over_sad, ecm.auto_over_anger
    ORDER BY
        ecm.call_date, ecm.call_time, ecm.login_id;`;

        connection.query(select_user_qry+coachingAdmin_qry, (err, results) => {
            if (err) {
                logger.error(`[ app.js:select_user_qry ] ${err}`);
                connection.end();
            }
            let selected_user = results[0];
            let needed_coach = results[1];

            res.render('index', {
                title: 'MindSupport 관리자 코칭',
                body: 'coachingAdmin',
                session_name: req.session.user.user_name,
                selected_user: selected_user,
                needed_coach: needed_coach,
                filtered_user_loginid: coachingData.user_loginid || '', // 값이 없을 경우 빈 문자열 전달
                filtered_user_name:coachingData.user_name || '' // 값이 없을 경우 빈 문자열 전달
            }, (err, html) => {
                if (err) {
                    logger.error(`[ app.js:/coachingAdmin ] Error rendering body: ${err}`);
                    res.status(500).send('Error rendering body');
                    
                    return;
                }
                
                // 성공 응답
                res.send(html);
            });
        });
    } catch (error) {
        logger.error('Error saving data:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// 관리자 코칭 이동시 검색 필터 유지
app.post('/coachingAdmin', (req, res) => {
    const { user_loginid, user_name } = req.body;

    // 세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/coachingAdmin ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        return res.status(401).json({ success: false, message: '세션이 만료되었습니다. 다시 로그인하세요.' });
    }

    try {
        // 사용자 정보를 세션에 저장
        req.session.coachingData = { user_loginid, user_name };

        // 클라이언트에 성공 응답 반환
        res.json({ success: true });
    } catch (error) {
        logger.error('Error saving data:', error);
        res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
    }
});

app.post('/resetFilters', (req, res) => {
    if (req.session) {
        // 초기화할 세션 값 설정
        req.session.searchGroup = null;
        req.session.filterConsultantName = null;
        logger.info('Session filters have been reset.');
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, message: 'Session does not exist.' });
    }
});

// 관리자 코칭 - 수동코칭
app.post('/coachingAdmin/sendMsg', (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:coachingAdmin/sendMsg ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `로그인` });
    }

    try {
        let testChk = req.body;
        logger.info(`[ app.js:coachingAdmin/sendMsg ] 전달받은 조건\n${JSON.stringify(testChk, null, 2)}`);

        // 코칭 메세지, 상담원 ID, 감성 초과 횟수 화남/슬픔, 코칭 번호 값을 전달받는다.
        let coach_msg = req.body.getMsgDetail;
        let coach_loginId = req.body.getLoginId;
        let getOverAnger = req.body.getOverAngerP;
        let getOverSad = req.body.getOverSadP;
        let getAutoSeq = req.body.getSeqNo;
        let getCallTime = req.body.getCallTime;
        logger.warn(coach_msg);
    
        //  세션 정보가 담긴 map 객체에서 조회
        if (loginIDsArr.has(coach_loginId)) {
            const value = loginIDsArr.get(coach_loginId);
            logger.info(`[ app.js:/coachingAdmin/sendMsg ] 코칭 할 상담원: ${value.id}, ${value.user}`);
            logger.info(`[ app.js:/coachingAdmin/sendMsg ] 기준 시간 : 10초`);
            logger.info(`[ app.js:/coachingAdmin/sendMsg ] 수동 코칭 메세지 내용\n${coach_msg}`);

            try {
                let upt_pass_query = `UPDATE emo_coaching_message 
                SET send_yn = 'Y',
                    send_dt = NOW(3),
                    auto_detail = '${coach_msg}'
                WHERE login_id = '${value.id}'
                    AND call_time = '${getCallTime}'
                    AND auto_seq = ${getAutoSeq}
                    AND agent_anger = '${getOverAnger}'
                    AND agent_sad = '${getOverSad}'
                    AND auto_standard = '10'
                    AND call_date >= DATE_FORMAT('${DateUtils.getYearMonthDay()}', '%Y-%m-%d') 
                    AND auto_coach = 'P';`;
                    // auto_standard 값과 auto_coach 값은 coachingAdmin.ejs 에서 값을 받아올 수 없음
                    // coachingAdmin.ejs에 정의되어있지 않음 의도치 않게 하드코딩을 하였음...
                logger.info(upt_pass_query)

                connection.query(upt_pass_query, (err, results) => {
                    if (err) {
                        logger.error(`[ app.js:/coachingAdmin/sendMsg ] ${err}`);
                        connection.end();
                    }

                    // 소켓을 통해 메세지 전송
                    io.to(value.socket).emit('admin_msg', ` ──────────────── [관리자 메세지] ────────────────
    ** ${value.user}님! 관리자로부터 메세지가 도착했습니다. **
    " ${coach_msg} "        ${DateUtils.getCurrentDate()}
    ────────────────────────────────────────`);

                    res.status(200).send({ message: `success`});
                });
            } catch(err) {
                logger.error(`[ app.js:/coachingAdmin/sendMsg ] 웹소켓 메세지 전송 오류`);
                res.status(500).send({ message: `오류 발생`});
            }
        } else {
            logger.warn(`[ app.js:/coachingAdmin/sendMsg ] 해당 상담원은 접속 중 아님`);

            res.status(200).send({ message: `notOnline`});
        }
    } catch(err) {
        logger.error(`[ app.js:coachingAdmin/sendMsg ] API 오류 ${err}`);
        res.status(500).send({ message: `오류 발생`});
    }
});

// 감성판단 검색
app.post('/searchEmoCon', (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/searchEmoCon ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `로그인` });
    }
    let jsonData = req.body;

    //  검색조건으로 쿼리
    let search_emo_qry = ``;

    logger.warn(`[ app.js:searchEmoCon ] 조회 요청 조건\n${JSON.stringify(jsonData, null, 2)}`);
})

//  요약통계
app.get('/statsSummary', (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/statsSummary ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `로그인` });
    }

    // 현재 경로 세션에 저장
    sessionUser.current_path = '/statsSummary';
    logger.info(`[ app.js:/statsSummary ] 현재 경로: ${sessionUser.current_path}`);

    try{
        let select_statsSummary_query = `
        WITH
        emotion_summary AS (
            SELECT 
                login_id,
                DATE_FORMAT(send_dt, '%Y-%m-%d') as emotion_date,
                COUNT(*) as emotion_records_per_date,
                SUM(CASE WHEN emotion_type = "1" THEN 1 ELSE 0 END) AS eei_emotion_info_none,
                SUM(CASE WHEN emotion_type IN ("3", "8", "14") THEN 1 ELSE 0 END) AS eei_emotion_info_angry,
                SUM(CASE WHEN emotion_type IN ("2", "9", "10", "11") THEN 1 ELSE 0 END) AS eei_emotion_info_peace,
                SUM(CASE WHEN emotion_type IN ("4", "7", "12", "13") THEN 1 ELSE 0 END) AS eei_emotion_info_sad,
                SUM(CASE WHEN emotion_type IN ("5", "6") THEN 1 ELSE 0 END) AS eei_emotion_info_happy
            FROM ETRI_EMOTION.emo_emotion_info
            WHERE 
                emotion_type IS NOT NULL 
                AND emotion_type != "0"
            GROUP BY login_id, DATE_FORMAT(send_dt, '%Y-%m-%d')
            ),
        coaching_summary AS (
            SELECT 
                login_id,
                DATE_FORMAT(call_date, '%Y-%m-%d') as coach_date,
                SUM(CASE WHEN auto_coach = 'P' THEN 1 ELSE 0 END) as manual_coach_count,
                SUM(CASE WHEN auto_coach = 'A' THEN 1 ELSE 0 END) as auto_coach_count
            FROM ETRI_EMOTION.emo_coaching_message
            GROUP BY login_id, DATE_FORMAT(call_date, '%Y-%m-%d')
            ),
        rec_duration_summary AS (
            SELECT 
                AGENT_ID,
                REC_START_DATE,
                SUM(REC_DURATION) as total_duration,
                COUNT(DISTINCT REC_START_TIME) as call_count
            FROM acr_v4.t_rec_data${DateUtils.getYearMonth()}
            GROUP BY AGENT_ID, REC_START_DATE
            )
            SELECT 
                eui.user_name,
                eui.group_type,
                eui.login_id,
                eui.age,
                eui.sex,
                eui.mbti_type,
                acr.REC_START_DATE,
                es.eei_emotion_info_none,
                es.eei_emotion_info_angry,
                es.eei_emotion_info_peace,
                es.eei_emotion_info_sad,
                es.eei_emotion_info_happy,
                es.emotion_records_per_date,
                cs.manual_coach_count,
                cs.auto_coach_count,
                DATE_FORMAT(ecm.call_date, '%Y-%m-%d') AS formatted_call_date,
                CONCAT(
                    FLOOR(rds.total_duration / 3600), ' 시간 ',
                    FLOOR((rds.total_duration % 3600) / 60), ' 분 ',
                    rds.total_duration % 60, ' 초'
                ) AS total_rec_duration_hms,
                rds.call_count AS total_records_per_date
            FROM ETRI_EMOTION.emo_user_info eui
            LEFT JOIN emotion_summary es 
                ON eui.login_id = es.login_id
            LEFT JOIN coaching_summary cs
                ON eui.login_id = cs.login_id
                AND cs.coach_date = es.emotion_date
            LEFT JOIN ETRI_EMOTION.emo_coaching_message ecm 
                ON eui.login_id = ecm.login_id
                AND DATE_FORMAT(ecm.call_date, '%Y-%m-%d') = es.emotion_date
            LEFT JOIN rec_duration_summary rds
                ON eui.login_id = rds.AGENT_ID
                AND DATE_FORMAT(ecm.call_date, '%Y-%m-%d') = DATE_FORMAT(rds.REC_START_DATE, '%Y-%m-%d')
            LEFT JOIN acr_v4.t_rec_data${DateUtils.getYearMonth()} acr 
                ON ecm.login_id = acr.AGENT_ID
                AND es.emotion_date = acr.REC_START_DATE
            WHERE 
                ecm.call_date IS NOT NULL
                AND acr.REC_DURATION IS NOT NULL
                AND acr.REC_START_DATE IS NOT NULL
            GROUP BY 
                acr.REC_START_DATE,
                eui.user_name,
                eui.group_type,
                eui.login_id,
                formatted_call_date,
                es.eei_emotion_info_none,
                es.eei_emotion_info_angry,
                es.eei_emotion_info_peace,
                es.eei_emotion_info_sad,
                es.eei_emotion_info_happy,
                cs.manual_coach_count,
                cs.auto_coach_count,
                rds.total_duration,
                rds.call_count
            ORDER BY formatted_call_date DESC;`

        let select_user_info_query = `
        SELECT user_name,
        login_id
        FROM emo_user_info
        WHERE group_manager != 'Y' 
        AND user_type != 3;`

        connection.query(select_statsSummary_query+select_user_info_query, (err, results) => {
            if (err){
                logger.error(`[] app.js:statsSumarry_query ] ${err}`);
            }

            let stats_summary = results[0];
            let stats_summary_user_info = results[1];

            res.render('index', {
                title: 'MindSupport  요약통계',
                body: 'statsSummary',
                stats_summary: stats_summary,
                stats_summary_user_info: stats_summary_user_info,
                session_id: req.session.user.user_name
            }, (err, html) => {
                if (err) {
                    logger.error(`[ app.js:/statsSummary ] Error rendering body: ${err}`);
                    res.status(500).send('Error rendering body');
                    
                    return;
                }
    
                res.send(html);
            });
        });
    } catch (error) {
        logger.error('Error saving data:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

//  상세통계
app.get('/statsDetail', (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/statsDetail ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `로그인` });
    }

    // 현재 경로 세션에 저장
    sessionUser.current_path = '/statsDetail';
    logger.info(`[ app.js:/statsDetail ] 현재 경로: ${sessionUser.current_path}`);

    try{
        let select_statsDetail_query = `
        WITH emotion_summary AS (
            SELECT 
                login_id, -- 로그인 ID
                file_name,  -- 파일명
                COUNT(*) as emotion_records_per_file,  -- 파일별 감성요청 횟수
                
                -- 상담원 감정 상태
                SUM(CASE WHEN emotion_type = "1" THEN 1 ELSE 0 END) AS eei_emotion_info_none,
                SUM(CASE WHEN emotion_type IN ("3", "8", "14") THEN 1 ELSE 0 END) AS eei_emotion_info_angry,
                SUM(CASE WHEN emotion_type IN ("2", "9", "10", "11") THEN 1 ELSE 0 END) AS eei_emotion_info_peace,
                SUM(CASE WHEN emotion_type IN ("4", "7", "12", "13") THEN 1 ELSE 0 END) AS eei_emotion_info_sad,
                SUM(CASE WHEN emotion_type IN ("5", "6") THEN 1 ELSE 0 END) AS eei_emotion_info_happy,

                -- 고객 감정 상태
                SUM(CASE WHEN cusEmoType = "1" THEN 1 ELSE 0 END) AS eei_emotion_cus_info_none,
                SUM(CASE WHEN cusEmoType IN ("3", "8", "14") THEN 1 ELSE 0 END) AS eei_emotion_cus_info_angry,
                SUM(CASE WHEN cusEmoType IN ("2", "9", "10", "11") THEN 1 ELSE 0 END) AS eei_emotion_cus_info_peace,
                SUM(CASE WHEN cusEmoType IN ("4", "7", "12", "13") THEN 1 ELSE 0 END) AS eei_emotion_cus_info_sad,
                SUM(CASE WHEN cusEmoType IN ("5", "6") THEN 1 ELSE 0 END) AS eei_emotion_cus_info_happy
            FROM ETRI_EMOTION.emo_emotion_info -- JOIN되는 테이블이 많아 내부 쿼리 출동을 방지하기 위해 WITH절을 이용한 CTE 정의
            WHERE 
                emotion_type IS NOT NULL -- 감정 타입이 있는 데이터만 선택
                AND file_name IS NOT NULL  -- 파일명이 있는 데이터만 선택
            GROUP BY login_id, file_name  -- 파일명 기준으로 그룹화
            ),
            coaching_summary AS (
                SELECT 
                    login_id,
                    DATE_FORMAT(call_date, '%Y-%m-%d') as coach_date, -- 코칭 데이터가 테이블에 INSERT된 날짜
                    SUM(CASE WHEN auto_coach = 'P' THEN 1 ELSE 0 END) as manual_coach_count, -- 수동 코칭 횟수
                    SUM(CASE WHEN auto_coach = 'A' THEN 1 ELSE 0 END) as auto_coach_count -- 자동 코칭 횟수
                FROM ETRI_EMOTION.emo_coaching_message
                GROUP BY login_id, DATE_FORMAT(call_date, '%Y-%m-%d')
            )
            SELECT 
                eui.user_name,
                eui.group_type,
                eui.login_id,
                eui.age,
                eui.sex,
                eui.mbti_type,
                DATE_FORMAT(acr.REC_START_DATE, '%Y-%m-%d') as formatted_date,
                acr.TARGET_TELNO,
                acr.MEMO,
                -- 시간 형식 변환 ( 24시간 형식을 AM,PM 12시간제로 변환 )
                DATE_FORMAT(acr.REC_START_TIME, '%H시 %i분 %s초') as formatted_time,
                acr.REC_FILENAME,
                es.emotion_records_per_file,
                es.eei_emotion_info_none,
                es.eei_emotion_info_angry,
                es.eei_emotion_info_peace,
                es.eei_emotion_info_sad,
                es.eei_emotion_info_happy,

                es.eei_emotion_cus_info_none,
                es.eei_emotion_cus_info_angry,
                es.eei_emotion_cus_info_peace,
                es.eei_emotion_cus_info_sad,
                es.eei_emotion_cus_info_happy,

                cs.manual_coach_count,
                cs.auto_coach_count,
                -- 통화시간을 분,초 형식으로 변환
                -- 한번의 통화를 1시간 이상 하는 경우는 없을거라고 생각하여 "시간" 표시 제외
                DATE_FORMAT(ecm.call_date, '%Y-%m-%d') AS formatted_call_date,
                CONCAT(FLOOR(acr.REC_DURATION / 60), ' 분 ', acr.REC_DURATION % 60, ' 초') AS call_duration

            FROM ETRI_EMOTION.emo_user_info eui -- 상담원 정보 테이블
            LEFT JOIN emotion_summary es 
                ON eui.login_id = es.login_id
                
            LEFT JOIN acr_v4.t_rec_data${DateUtils.getYearMonth()} acr -- 통화 녹취 테이블
                ON es.file_name = acr.REC_FILENAME  -- 파일명으로 매핑

            LEFT JOIN ETRI_EMOTION.emo_coaching_message ecm -- 코칭 메세지 테이블
                ON eui.login_id = ecm.login_id
                AND DATE_FORMAT(ecm.call_date, '%Y-%m-%d') = acr.REC_START_DATE

            LEFT JOIN coaching_summary cs
                ON eui.login_id = cs.login_id
                AND cs.coach_date = acr.REC_START_DATE

            WHERE 
                acr.REC_FILENAME IS NOT NULL  -- 파일명이 있는 데이터만 선택
                AND acr.REC_START_DATE IS NOT NULL -- 통화 날짜가 있는 데이터만 선택
            GROUP BY 
                -- 통화 관련 그룹
                acr.REC_START_DATE,
                acr.REC_START_TIME,
                acr.REC_FILENAME,

                -- 상담원 정보별 그룹
                eui.user_name,
                eui.group_type,
                eui.login_id,

                -- 기타 정보 그룹
                es.eei_emotion_info_none,
                es.eei_emotion_info_angry,
                es.eei_emotion_info_peace,
                es.eei_emotion_info_sad,
                es.eei_emotion_info_happy,
                es.emotion_records_per_file,
                cs.manual_coach_count,
                cs.auto_coach_count,
                acr.REC_DURATION
            ORDER BY 
                acr.REC_START_DATE DESC, -- 최신 날짜부터
                acr.REC_START_TIME DESC;` //최신 시간부터

        let select_user_info_query = `
            SELECT user_name,
            login_id
            FROM emo_user_info
            WHERE group_manager != 'Y'
            AND user_type != 3;`

        connection.query(select_statsDetail_query+select_user_info_query, (err,results) => {
            if (err){
                logger.warn(`[] app.js:statsDetail_query ${err}`);
            }

            let stats_detail = results[0];
            let stats_detail_user_info = results[1];

            res.render('index', {
                title: 'MindSupport 상세통계',
                body: 'statsDetail',
                stats_detail: stats_detail,
                stats_detail_user_info: stats_detail_user_info,
                session_id: req.session.user.user_name
            }, (err, html) => {
                if (err) {
                    logger.error(`[ app.js:/statsDetail ] Error rendering body: ${err}`);
                    res.status(500).send('Error rendering body');
                    
                    return;
                }
        
                res.send(html);
            });
        });
    } catch (error){
        logger.error('Error saving data:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

//  사용자 관리
app.get(`/settingUser`, (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/settingUser ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `로그인` });
    }

    // 현재 경로 세션에 저장
    sessionUser.current_path = '/settingUser';
    logger.info(`[ app.js:/settingUser ] 현재 경로: ${sessionUser.current_path}`);

    try{
        //  사용자 리스트 전체 조회
            let settingUser_query = `SELECT
            b.org_id,
            b.org_name,
            a.userinfo_userid,
            a.login_id,
            a.user_name,
            a.group_type,
            a.age,
            a.sex,
            a.note,
            a.dev_platform 
        FROM emo_user_info AS a
        INNER JOIN emo_provider_info as b
        ON a.org_name = b.org_name
        WHERE a.del_yn IS NULL
        AND a.user_type != 3`;

        connection.query(settingUser_query, (err, results) => {
            if (err) {
                logger.error(`[ app.js:settingUser_query ] ${err}`);
                connection.end();
            }
    
            let manage_users = results;
    
            res.render('index', {
                title:`MindSupport 사용자 관리`,
                body: 'settingUser', 
                manage_users: manage_users,
                session_id: req.session.user.user_name
            }, (err, html) => {
                if (err) {
                    logger.error(`[ app.js:/settingUser ] Error rendering body: ${err}`);
                    res.status(500).send('Error rendering body');
                    
                    return;
                }
    
                res.send(html);
            });
        });
    } catch (error) {
        logger.error('Error saving data:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

//  메모 관리 (20240813_최정우 연구원)
app.get('/settingMemo', (req, res) => {
    //  세션 체크
    if (!req.session || !req.session.authenticate || !req.session.user) {
        logger.info(`[ app.js:/settingMemo ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
        res.redirect(`/`, { title: `로그인` });
    }

    //  현재 경로 세션에 저장
    sessionUser.current_path = '/settingMemo';
    logger.info(`[ app.js:/settingMemo ] 현재 경로: ${sessionUser.current_path}`);

    try{
        // 사용자 리스트 전체 조회
        let settingMemo_query = `SELECT
            a.userinfo_userid,
            a.user_name,
            a.group_type,
            a.age,
            a.sex,
            a.note,
            b.memo_head_num,
            b.manager_name,
            b.login_id,
            b.user_name,
            b.memo,
            b.reg_time,
            b.update_time
        FROM emo_user_info AS a
        INNER JOIN emo_manager_memo AS b
        ON a.user_name = b.user_name
        WHERE a.group_manager = 'N'
        ORDER BY b.memo_head_num DESC;`;

        let selected_user_query = `SELECT
            user_name,
            login_id,
            group_type
        FROM emo_user_info
        WHERE group_manager != 'Y'
        AND user_type != 3;`;

        connection.query(settingMemo_query + selected_user_query, (err, results) => {
            if (err) {
                logger.error(`[ app.js:settingMemo_query] ${err}`);
                connection.end();
            }
            let selected_user = results[1]

            // reg_time, update_time이 KST타임 형태로 표시되므로 형식 포맷후 데이터 전송
            let manage_memo = results[0].map(data => {
                let reg_time = data.reg_time;
                let update_time = data.update_time;
                let formattedRegDate = DateUtils.getYearMonthDayHoursMinutes(reg_time);
                let formattedUpdtDate = DateUtils.getYearMonthDayHoursMinutes(update_time);
                return { ...data, reg_time: formattedRegDate, update_time: formattedUpdtDate };
            });
            
            //  쿼리
            res.render('index', {
                title: 'MindSupport 메모 관리',
                body: 'settingMemo',
                manage_memo: manage_memo,
                selected_user: selected_user,
                session_id: req.session.user.user_name
            }, (err, html) => {
                if (err) {
                    logger.error(`[ app.js:/settingMemo ] Error rendering body: ${err}`);
                    res.status(500).send('Error rendering body');
                        
                    return;
                }

                res.send(html);
            });
        });
    } catch (error) {
        logger.error('Error saving data:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

    // 메모 등록 (20240819_최정우 연구원)
app.post('/submitMemo', (req, res) => {
    const { manager_name, login_id, user_name, memo } = req.body;

    // 입력 데이터 유효성 검사 실시
    if (!manager_name || !login_id || !user_name || !memo) {
        res.status(400).json({ success: false, message: '모든 필드를 입력해주세요.' });
        return;
    }

    // login_id가 emo_user_info 테이블에 존재하는지 확인하는 쿼리 ( 존재하는 사용자인지 확인 )
    const checkLoginIdQuery = `SELECT COUNT(*) AS count FROM emo_user_info WHERE login_id = ?`;
    connection.query(checkLoginIdQuery, [login_id], (err, result) => {
        if (result[0].count === 0) {
            logger.info('[app.js:submitMemo ] ', result[0].count);
            logger.error(`[ app.js:submitMemo ] ${err}`);
            return res.status(500).json({ success: false, message: '존재하지 않는 상담원 ID 입니다.' });
        }
        else logger.info('[ app.js:submitMemo ] ', result[0].count);

        // emo_user_info 테이블에서 login_id와 user_name이 일치하는지 확인
        const checkUserQuery = `SELECT user_name, group_manager FROM emo_user_info WHERE login_id = ? AND user_name = ?`;
        connection.query(checkUserQuery, [login_id, user_name], (err, userResults) => {
            if (err) {
                logger.error(`[ app.js:/submitMemo ] ${err}`);
                res.status(500).json({ success: false, message: '메모 등록 중 오류가 발생했습니다.' });
                return;
            }

            if (userResults.length === 0) {
                res.status(400).json({ success: false, message: '상담원 ID와 상담원 명이 일치하지 않습니다.' });
                return;
            }
                // 현재 가장 높은 memo_head_num 조회 // head_num을 연속적으로 하기 위함
                const getMaxMemoHeadNumQuery = `SELECT MAX(memo_head_num) AS max_num FROM emo_manager_memo`;
                connection.query(getMaxMemoHeadNumQuery, (err, results) => {
                    if (err) {
                        logger.error(`[ app.js:/submitMemo ] ${err}`);
                        res.status(500).json({ success: false, message: '메모 등록 중 오류가 발생했습니다.' });
                        return;
                    }

                    // 새로운 memo_head_num 계산 // 그냥 AUTO INCREMENT로 데이터를 넣을 경우 연속성이 없음
                    const maxMemoHeadNum = results[0].max_num || 0;
                    const newMemoHeadNum = maxMemoHeadNum + 1;

                    // 메모 삽입 쿼리 준비
                    const insertQuery = `INSERT INTO emo_manager_memo (memo_head_num, manager_name, login_id, user_name, memo, reg_time) VALUES (?, ?, ?, ?, ?, NOW())`;
                    connection.query(insertQuery, [newMemoHeadNum, manager_name, login_id, user_name, memo], (err) => {
                        if (err) {
                            logger.error(`[ app.js:/submitMemo ] ${err}`);
                            res.status(500).json({ success: false, message: '메모 등록 중 오류가 발생했습니다.' });
                            return;
                        }

                    res.json({ success: true, message: '메모가 성공적으로 등록되었습니다.' });
                });
            });
        });
    });
});

    // 메모 수정 (20240819_최정우 연구원)
app.post('/updateMemo', (req, res) => {
    const { login_id, selectedLoginId, manager_name, user_name, memo, update_memo_head_num } = req.body;

    // 입력 데이터 유효성 검사 실시
    // 관리자 ID, 상담원 ID, 상담원 명을 고정값으로 넣어줬기때문에 유효성 검사는 메모 내용만 실시
    if (!memo) {
        res.status(400).json({ success: false, message: '메모 내용을 입력해주세요.' });
        return;
    }

    // 메모 업데이트 쿼리
    const updateQuery = `UPDATE emo_manager_memo SET manager_name = ?, login_id = ?, user_name = ?, memo = ?, update_time = NOW() WHERE login_id = ? AND memo_head_num = ?`;
    connection.query(updateQuery, [manager_name, login_id, user_name, memo, selectedLoginId, update_memo_head_num], (err) => {
        if (err) {
            logger.error(`[ app.js:/updateMemo ] Error in updating memo: ${err.message}`);
            res.status(500).json({ success: false, message: '메모 수정 중 오류가 발생했습니다.' });
            return;
        } else {
            res.json({ success: true, message: '메모가 성공적으로 수정되었습니다.' });
        }
    });
});

    // 메모 삭제 (20240819_최정우 연구원)
app.post('/deleteMemo', (req, res) => {
    const { memo_head_num } = req.body;

    // 숫자 배열로 변환 (memo_head_num 데이터 값이 int값이기 때문에 바로 넣을려면 숫자 배열로 변환하는게 편함)
    const memoHeadNumArray = memo_head_num.map(num => parseInt(num, 10)).filter(num => !isNaN(num));

    if (memoHeadNumArray.length === 0) {
        return res.json({ success: false, message: '유효한 메모 번호가 없습니다.' });
    }

    // 삭제 쿼리와 재정렬 쿼리를 하나의 쿼리로 결합
    const combinedQuery = `
        -- 메모 삭제
        DELETE FROM emo_manager_memo
        WHERE memo_head_num IN (?);
        
        -- 메모 번호 재정렬
        SET @rownum := 0;
        UPDATE emo_manager_memo 
        SET memo_head_num = (@rownum := @rownum + 1)
        ORDER BY reg_time ASC;
    `;
    
    connection.query(combinedQuery, [memoHeadNumArray], (err, results) => {
        if (err) {
            logger.error(`[ app.js:/deleteMemo ] Error in deleting memo: ${err.message}`);
            res.status(500).json({ success: false, message: '메모 삭제 중 오류가 발생했습니다.' });
            return;
        }

        const deleteResult = results[0];
        if (deleteResult.affectedRows === 0) {
            res.status(404).json({ success: false, message: '삭제할 메모를 찾을 수 없습니다.' });
            return;
        }

        res.json({ success: true, message: '메모가 성공적으로 삭제되었습니다.' });
    });
});

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////// RMQ ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

//  실시간 감성인지 처리: 녹취 서버와 MindSupport 서버에 nfs-server, nfs-client 설치
//   - 녹취 서버에 마운트 후 chokidar 라이브러리로 파일 이벤트 모니터링
//    - 1) 녹취 파일 생성시 
//    - 2) 녹취 도중
//    - 3) 녹취 종료 판단 (DB의 REC_END_DATETIME 이 NULL이 아니면 && 녹취 파일의 용량이 더이상 증가하지 않을 때)
let ErkApiMsg;  // 추후 Stream Queue 생성시 proto 파일 중복 로드 방지
async function loadProto() {
    try {
        const protobuf_dir = `/home/neighbor/MindSupport/MindSupport_v1.0.0/public/proto/241212_ErkApiMsg_ETRI_v3_3.proto`;
        const root = await protobuf.load(protobuf_dir);
        logger.info(`[ app.js:loadProto ] ErkApiMsg.proto 불러오기 성공`);

        //  3.1. Oneof 형식 메세지 구조 불러오기
        ErkApiMsg = root.lookupType("ErkApiMsg");

        return ErkApiMsg;
    } catch(err) {
        logger.error(`[ app.js:loadProto ] Proto 파일 로드 중 오류 발생: ${err}`);
        throw err;
    }
}

//  AMQP - 동기/비동기 가능(라이브러리 활용에 따라 다름. 주로 callback-api 라이브러리를 씀)
let ch; // 상담원 채널
let ch2;    // 고객 채널
let conn;   // rmq 연결정보 저장
let receiveQueueName;
let sendQueueName;

//  GSM to PCM Converting (실제 녹음 시, 적용되어야 할 부분)
let gsmStream;
let copyInterval;

conn = amqp.connect({
    hostname: process.env.RABBITMQ_HOST,
    port: process.env.RABBITMQ_PORT,
    username: process.env.RABBITMQ_ID,
    password: process.env.RABBITMQ_PASSWORD
}, (err, conn) => {
    if (err) {
        logger.error(`[ AMQP:amqpConnect ] ${err}`);
        return;
    }
    logger.info(`[ AMQP:amqpConnect ] AMQP 연결 성공`);

    //  1. 상담원 채널 생성
    ch =  conn.createChannel(err => {
        if(err) {
            logger.error(`[ AMQP:createChannel ] ${err}`);
            throw err;
        }
        logger.info(`[ AMQP:createChannel ] AMQP 상담원 채널 생성 성공`);
    });

    //  1. 고객 채널 생성
    ch2 =  conn.createChannel(err => {
        if(err) {
            logger.error(`[ AMQP:createChannel ] ${err}`);
            throw err;
        }
        logger.info(`[ AMQP:createChannel ] AMQP 고객 채널 생성 성공`);
    });

    //  2. Neighbor System 전용 송신 Classic 큐 생성( 감성인지를 제외한 모든 인터페이스에 대한 응답 처리 )
    //   - RabbitMQ Manangement로 확인을 해보면 ‘Classic’, ‘Quorum’, ‘Stream’이 있음을 확인
    //      1) Classic Queue:  FIFO(First In, First Out) 형태를 가지는 메시지 큐를 의미
    //      2) Quorum Queue: 메시지 브로커에서 메시지 손실을 방지하게 개발된 기능
    //      3) Stream Queue: 높은 처리량과 메시지 순서를 유지할 수 있는 기능을 제공
    //   - durable : true로 설정하면 RabbitMQ가 재시작되어도 생성된 exchange가 그대로 유지
    //   - 화자1 (상담원용 classic queue)
    const chName = 'NEIGHBOR_SYSTEM3';
    ch.assertQueue(chName, {
        durable: true,
        arguments: {
            'x-queue-type': 'classic'
        } 
    }, (err) => {
        if (err) {
            logger.error(`[ AMQP:assertQueue ] ${err}`);
            return false;
        }

        //  기본 인터페이스를 위한 클래식 큐
        logger.info(`[ AMQP:assertQueue ] Classic 메세지 큐(${chName}) 생성 성공`);
    });

    //   - 화자2 (고객용 classic queue)
    const chName_2 = 'NEIGHBOR_SYSTEM4';
    ch2.assertQueue(chName_2, {
        durable: true,
        arguments: {
            'x-queue-type': 'classic'
        } 
    }, (err) => {
        if (err) {
            logger.error(`[ AMQP:assertQueue ] ${err}`);
            return false;
        }

        //  기본 인터페이스를 위한 클래식 큐
        logger.info(`[ AMQP:assertQueue ] Classic 메세지 큐(${chName_2}) 생성 성공`);
    });

    ch2.on('close', () => {
        isChannelReady = false;
        console.log('채널2 닫힘');
    });
    
    ch2.on('error', (err) => {
        isChannelReady = false;
        console.error('채널2 에러:', err);
    });

    //  3. ErkApiMsg proto 파일 불러오기
    let ErkQueueInfo;
    let ErkQueueInfo2;
    let ErkEngineInfo;

    //  Protobuf 
    loadProto()
        .then(async (ErkApiMsg) => {
            //  파일 모니터링 시작
            await watchDirectory();

            // 기본 큐 정보 초기화
            ErkQueueInfo = ErkApiMsg.create({
                ToQueueName: "ERK_API_QUEUE",
                FromQueueName: "NEIGHBOR_SYSTEM3"
            });
            ErkQueueInfo2 = ErkApiMsg.create({
                ToQueueName: "ERK_API_QUEUE",
                FromQueueName: "NEIGHBOR_SYSTEM4"
            });

            //  Erk 엔진 정보
            ErkEngineInfo = ErkApiMsg.create({
                EngineType: 2, // speech
                EngineCondition: ErkQueueInfo,
                IpAddr: null,
                ReceiveQueueName: null,
                SendQueueName: null
            });

            setErkApiMsg(ErkApiMsg, ch, ch2, ErkQueueInfo, ErkQueueInfo2);

            //  * 회원가입 = 프로파일링, 로그인 = 서비스 커넥션이라고 이해하면 쉬울 것
            //  3.3. 사업자 프로파일링 ( 서버 기동 시, 사업자 프로파일링 체크 )
            let select_orgid_null = `SELECT * FROM emo_provider_info WHERE org_id IS NULL;`;
            connection.query(select_orgid_null, (err, results) => {
                if(err) {
                    logger.error(`[ AMQP:select_orgid_null ] ${err}`);
                    throw err;
                }
                logger.info(`[ AMQP:selectOrgId ] OrgId 요청해야 할 서비스 항목 ${results.length}건`);

                //  3.4.1. 사업자 등록
                //   - 추가적인 사업자가 필요하다면
                if(results.length > 0) {
                    for(let i=0; i<results.length; i++) {
                        let addSrvcMsg = ErkApiMsg.create({
                            AddServiceProviderInfoRQ: {
                                MsgType: 1,
                                QueueInfo: ErkQueueInfo,
                                OrgName: results[i].org_name,
                                OrgPwd: results[i].org_pwd,
                                ProviderType: results[i].provider_type,
                                ServiceDuration: results[i].service_duration,
                                UserNumber: results[i].user_number,
                                ServiceType: results[i].service_type
                            }
                        });
                        let addSrvcMsg_buf = ErkApiMsg.encode(addSrvcMsg).finish();

                        // 사업자 등록 요청 데이터 저장 SQL
                        let upt_add_provider = `UPDATE emo_provider_info
                        SET send_dt = NOW(3), insert_dt = NOW(3)
                        WHERE org_name = "${results[i].org_name}";`;

                        //  3.4.2. 사업자 등록 요청 전송
                        connection.query(upt_add_provider, (err) => {
                            if (err) {
                                logger.error(`[ AMQP:uptProviderErr ] ${err}`);
                                connection.end();
                            }

                            // 전송 이력 DB 저장 후 메세지 송신
                            logger.info(`[ AMQP:AddServiceProviderInfoRQ ] 메세지 송신 결과\n${JSON.stringify(addSrvcMsg, null, 4)}`);
                            ch.sendToQueue("ERK_API_QUEUE", addSrvcMsg_buf);

                            addSrvcMsg_buf = null;
                            addSrvcMsg = null;
                            upt_add_provider = null;
                        });
                    }
                } else {
                    logger.info(`[ AMQP:selectUsr ] 등록할 서비스 사업자가 없음. 사용자 프로파일링 진행`);
                    
                    //  3.5. 사용자 프로파일링
                    let select_add_usr_info = `SELECT
                        a.userinfo_userId,
                        a.org_name,
                        a.user_name,
                        a.login_id,
                        a.login_pw,
                        b.service_duration,
                        a.age,
                        a.sex,
                        a.mbti_type,
                        a.user_type,
                        b.service_type
                    FROM emo_user_info a
                    LEFT JOIN emo_provider_info b
                    ON a.org_name = b.org_name 
                    WHERE b.org_id IS NOT NULL
                    AND a.userinfo_userId IS NULL;`;

                    connection.query(select_add_usr_info, (err, results) => {
                        if(err) {
                            logger.error(`[ AMQP:addUserInfo ] ${err}`);
                            connection.end();
                        }
                        logger.info(`[ AMQP:addUserInfo ] 사용자 등록 조회 결과 : ${results.length}건`);

                        //  조회 결과 0건
                        if(results.length === 0) {
                            logger.info(`[ AMQP:addUserInfo ] 등록할 사용자 없음`);
                        } else {
                            //  조회 결과 0건 이상
                            logger.info(`[ AMQP:addUserInfo ] 상담원 등록 인터페이스 ${results.length}건 진행`);

                            //  사용자 등록요청 메세지 생성
                            results.forEach(user => {
                                let addUsrMsg = ErkApiMsg.create({
                                    AddUserInfoRQ: {
                                        MsgType: 9,
                                        QueueInfo: ErkQueueInfo,
                                        OrgName: user.org_name,
                                        UserName: user.login_id,
                                        UserPwd: user.login_pw,
                                        ServiceDuration: user.service_duration,
                                        Age: user.age,
                                        Sex: user.sex,
                                        MbtiType: user.mbti_type,
                                        UserType: user.user_type,
                                        ServiceType: user.service_type
                                    }
                                });

                                let addUsrMsg_buf2 = ErkApiMsg.encode(addUsrMsg).finish();
                                let upt_add_usr_info = `UPDATE emo_user_info 
                                SET update_dt = NOW(3), userinfo_send_dt = NOW(3), userinfo_serviceType = "${user.service_type}"
                                WHERE login_id = "${user.login_id}"`;

                                // 전송 이력 DB 저장 후 메세지 송신
                                connection.query(upt_add_usr_info, (err, results) => {
                                    if(err) {
                                        logger.error(`[ AMQP:upt_addUsr_info ] ${err}`);
                                        connection.end();
                                    }

                                    logger.info(`[ AMQP:upt_addUsr_info ] ${upt_add_usr_info}`);
                                });

                                logger.info(`[ AMQP:AddUserInfoRQ ] 송신한 메세지\n${JSON.stringify(addUsrMsg, null, 4)}`);
                                ch.sendToQueue("ERK_API_QUEUE", addUsrMsg_buf2);
                            });
                        }
                    });
                }
            });

            //   3.4. 사업자 변경
            //   3.5. 사업자 삭제

            //  사용자 관리 페이지[등록]
            //   - 현재 사용하지 않고 있는 라이센스(서비스) ID를 부여
            //   - 나머지 사용자 정보는 직접 입력
            app.get(`/settingUserSubmit`, (req, res) => {
                //  세션 체크
                if (!req.session || !req.session.authenticate || !req.session.user) {
                    logger.info(`[ app.js:settingUserSubmit ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
                    res.redirect(`/`, { title: `로그인` });
                }
        
                try {
                    let jsonData = req.query;
                    logger.warn(`[ app.js:settingUserSubmit ] 등록 요청 데이터\n${JSON.stringify(jsonData, null, 2)}`);
            
                    let getOrgName_parse = jsonData.getOrgName.trim();
                    let getManagerAgent_parse = jsonData.getManagerAgent.trim();
        
                    let settingUserSubmit_query = `INSERT emo_user_info (org_name, login_id, login_pw, user_name, group_manager, group_type, user_type, age, sex, note, dev_platform)
                    VALUES ('${getOrgName_parse}', '${req.query.getUserId}', 'nb1234', '${req.query.getUserName}', '${getManagerAgent_parse}', '${req.query.getGroupType}', '1', ${Number(req.query.getAge)}, '${req.query.getSex}', '${req.query.getNote}', '${req.query.getPlatform}')`;
        
                    connection.query(settingUserSubmit_query, (err, result) => {
                        if(err) {
                            logger.error(`[ app.js:settingUser_query ] ${err}`);
                            connection.end();
                        }
                        logger.info(`[ app.js:settingUser_query ] ${JSON.stringify(result, null, 2)}`);
                        let select_add_usr_info = `SELECT
                            a.org_name,
                            a.user_id,
                            a.user_name,
                            a.login_id,
                            a.login_pw,
                            b.service_duration,
                            a.age,
                            a.sex,
                            a.mbti_type,
                            a.user_type,
                            a.group_manager,
                            a.group_type,
                            a.userinfo_send_dt,
                            a.userinfo_recv_dt,
                            a.userinfo_userId,
                            a.userinfo_return_code,
                            b.service_type
                        FROM emo_user_info a
                        LEFT JOIN emo_provider_info b
                        ON a.org_name = b.org_name 
                        WHERE b.org_id IS NOT NULL
                        AND a.userinfo_userId IS NULL;`;
            
                        connection.query(select_add_usr_info, (err, results) => {
                            if(err) {
                                logger.error(`[ AMQP:addUserInfo ] ${err}`);
                                connection.end();
                            }
                            logger.info(`[ AMQP:addUserInfo ] 사용자 등록 조회 결과 : ${results.length}건`);
            
                            results.forEach(user => {
                                let addUsrMsg = ErkApiMsg.create({
                                    AddUserInfoRQ: {
                                        MsgType: 7,
                                        QueueInfo: ErkQueueInfo,
                                        OrgName: user.org_name,
                                        UserName: user.login_id,
                                        UserPwd: user.login_pw,
                                        ServiceDuration: user.service_duration,
                                        Age: user.age,
                                        Sex: user.sex,
                                        MbtiType: user.mbti_type,
                                        UserType: user.user_type,
                                        ServiceType: user.service_type
                                    }
                                });
            
                                let addUsrMsg_buf2 = ErkApiMsg.encode(addUsrMsg).finish();
                                let upt_add_usr_info = `UPDATE emo_user_info SET update_dt = NOW(3), userinfo_send_dt = NOW(3) WHERE login_id = "${user.login_id}"`;
            
                                // 전송 이력 DB 저장 후 메세지 송신
                                connection.query(upt_add_usr_info, (err, results) => {
                                    if(err) {
                                        logger.error(`[ AMQP:upt_addUsr_info ] ${err}`);
                                        connection.end();
                                    }
            
                                    logger.info(`[ AMQP:sendToqueue ] 송신한 메세지\n${JSON.stringify(addUsrMsg, null, 4)}`);
                                });
                                ch.sendToQueue("ERK_API_QUEUE", addUsrMsg_buf2);
            
                                addUsrMsg = null;
                                addUsrMsg_buf2 = null;
                                upt_add_usr_info = null;
                            });
                        });
                    });
        
                    res.status(200).send({ message: '성공적으로 등록되었습니다.' });
                } catch(err) {
                    logger.error(`[ app.js:settingUserSubmit ] ${err}`);
                    res.status(500).send({ message: 'API 오류' });
                }
            });

            //  3.6. 사용자 변경
            //   - 사용자 관리[수정]
            app.get('/updatingUserSubmit', (req, res) => {
                //  세션 체크
                if (!req.session || !req.session.authenticate || !req.session.user) {
                    logger.info(`[ app.js:settingUserSubmit ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
                    res.redirect(`/`, { title: `로그인` });
                }

                try {
                    let jsonData = req.query;
                    logger.info(`[ app.js:updatingUserSubmit ] 사용자 정보 수정 요청 ${JSON.stringify(req.query, null, 2)}`);
            
                    let getOrgName_parse = jsonData.getOrgName.trim();
                    let updatingUserSubmit_query  = `UPDATE emo_user_info SET
                    org_name = '${getOrgName_parse}',
                    user_id = ${Number(jsonData.getUserId)},
                    user_name = '${jsonData.getUserName}',
                    group_type = '${getGroupType}',
                    age = '${req.query.getAge}',
                    sex = '${req.query.getSex}',  
                    dev_platform = '${req.query.getPlatform}',
                    note = '${req.query.getNote}'
                    WHERE user_id = ${Number(jsonData.getOriginOrgId)};`;

                    connection.query(updatingUserSubmit_query, (err, result) => {
                        if(err) {
                            logger.error(`[ app.js:updatingUserSubmit_query ] ${err}`);
                            connection.end();
                        }
                        logger.info(`[ app.js:updatingUserSubmit_query] ${result}`)
            
                        let upt_usr_info_query = `SELECT * FROM emo_user_info
                        WHERE user_id = ${Number(jsonData.getOriginOrgId)};`;
            
                        connection.query(upt_usr_info_query, (err, results) => {
                            if(err) {
                                logger.error(`[ app.js:upt_usr_info_query ] ${err}`);
                                connection.end();
                            }
            
                            if(results.length > 0) {
                                results.forEach(user => {
                                    let uptUsrMsg = ErkApiMsg.create({
                                        UpdUserInfoRQ: {
                                            MsgType: 11,
                                            QueueInfo: ErkQueueInfo,
                                            OrgName: user.org_name,
                                            UserName: user.login_id,
                                            Old_UserPwd: user.login_pw,
                                            Old_ServiceDuration: user.service_duration,
                                            Old_Age: user.age,
                                            Old_Sex: user.sex,
                                            Old_MbtiType: user.mbti_type,
                                            Old_UserType: user.user_type,
                                            Old_ServiceType: user.service_type,
                                            New_UserPwd,
                                            New_ServiceDuration,
                                            New_Age,
                                            New_Sex,
                                            New_MbtiType,
                                            New_UserType,
                                            New_ServiceType
                                        }
                                    });
                                });
                            } else{
                                logger.warn(`[ app.js:upt_usr_info_query ] 데이터 조회 안됨`);
                            }
                        });
                    });

                    res.status(200).send({ message: '성공적으로 수정되었습니다.' });
                } catch(err) {
                    logger.error(`[ app.js:updatingUserSubmit ] ${err}`);
                    res.status(500).send({ message: 'API 오류' });
                }
            });

            //  3.7. 사용자 삭제
            //   - 사용자 관리[삭제]
            //   - 해당 라이센스(서비스) ID는 빼놓기
            app.post(`/deletingUserSubmit`, (req, res) => {
                //  세션 체크
                if (!req.session || !req.session.authenticate || !req.session.user) {
                    logger.info(`[ app.js:deletingUserSubmit ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
                    res.redirect(`/`, { title: `로그인` });
                }
                logger.info(`[ app.js:deletingUserSubmit ] 받은 조건: ${JSON.stringify(req.body)}`);

                let del_user_id = req.body.userinfo_id;
                let del_user_name = req.body.user_name;

                try {                
                    for(let i=0; i<del_user_id.length; i++) {
                        let delete_usr_info = `SELECT * FROM emo_user_info WHERE user_name = '${del_user_name[i]}';`;
                        connection.query(delete_usr_info, (err, results) => {
                            if(err) {
                                logger.error(`[ app.js:delete_usr_info ] ${err}`);
                                connection.end();
                            }
            
                            if(results.length > 0) {
                                results.forEach(user => {
                                    let delUsrMsg = ErkApiMsg.create({
                                        DelUserInfoRQ: {
                                            MsgType: 9,
                                            QueueInfo: ErkQueueInfo,
                                            OrgName: user.org_name,
                                            UserName: user.login_id,
                                            UserPwd: user.login_pw
                                        }
                                    });
                                    let delUsrMsg_buf = ErkApiMsg.encode(delUsrMsg).finish();
                                    ch.sendToQueue("ERK_API_QUEUE", delUsrMsg_buf);

                                    logger.info(`[ app.js:delete_usr_info ] 송신한 메세지\n${JSON.stringify(delUsrMsg, null, 4)}`);
            
                                    delUsrMsg = null;
                                    delUsrMsg_buf = null;
                                    delete_usr_info = null;
                                });
                            } else {
                                logger.warn(`[ app.js:delete_usr_info ] 검색된 데이터 없음`);
                            }
                        });
                    }

                    res.status(200).json({ message: '모두 삭제 성공했습니다.' });
                } catch(err) {
                    logger.error(`[ app.js:deletingUserSubmit ] ${err}`);
                    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
                }
            });

            //  3.9. 감성인지 서비스 연결
            //   3.9.1. 서비스 연결 요청 및 처리
            //    - ErkMsgHead: MsgType, QueueInfo, OrgId, UserId(ETRI에서 부여한)
            //    - DB에서 returnCode를 받았다면
            //    - 사용자 로그인(제공된 계정을 사용)
            app.post('/manager/login', (req, res) => {
                // AJAX로 전달받은 데이터 저장
                let login_id_t = req.body.login_id;
                let login_pw_t = req.body.login_pw;
                let uuid = crypto.randomUUID(); // UUID 생성
                let uuid2 = crypto.randomUUID(); // UUID 생성

                logger.info('[ app.js:managerLogin ] 로그인 프로세스 호출');        
                logger.info(`[ app.js:managerLogin ] 입력된 사용자 계정: ${login_id_t}, 입력된 사용자 암호: ${login_pw_t}`);
        
                // 계정 혹은 암호 중 하나라도 입력이 안되었을 경우
                if (login_id_t.length == 0 && login_pw_t.length == 0) {
                    res.send(`<script type="text/javascript">
                    alert("계정과 암호를 올바르게 입력해주세요.");
                    document.location.href="/";</script>`);
        
                    logger.info(`[ API:managerLogin ] 입력된 계정 길이: ${login_id_t.length}, 입력된 암호 길이: ${login_pw_t.length}`);
                } else if (login_id_t.length == 0 && login_pw_t.length > 0) {
                    res.send(`<script type="text/javascript">
                    alert("계정과 암호를 올바르게 입력해주세요.");
                    document.location.href="/";</script>`);
        
                    logger.info(`[ API:managerLogin ] 입력된 계정 길이: ${login_id_t.length}, 입력된 암호 길이: ${login_pw_t.length}`);   
                } else if (login_id_t.length > 0 && login_pw_t.length == 0) {
                    res.send(`<script type="text/javascript">
                    alert("계정과 암호를 올바르게 입력해주세요.");
                    document.location.href="/";</script>`);
        
                    logger.info(`[ API:managerLogin ] 입력된 계정 길이: ${login_id_t.length}, 입력된 암호 길이: ${login_pw_t.length}`);   
                } else {
                    //  사업자 서비스 인증이 진행된 경우(userinfo_userId와 org_id가 있을 시) 로그인 진행
                    let login_chk_query = `SELECT * 
                    FROM emo_user_info eui 
                    LEFT JOIN emo_provider_info epi 
                    ON eui.org_name = epi.org_name 
                    WHERE epi.org_id IS NOT NULL 
                    AND eui.login_id = "${login_id_t}" 
                    AND eui.login_pw = "${login_pw_t}";`;
        
                    //  [ 로그인 체크 ] 입력된 계정, 암호로 db조회
                    connection.query(login_chk_query,  (error, results) => {
                        if (error) {
                            logger.error(`[ API:ManagerLogin ] ${error}`);
                            connection.end();
                        }
        
                        if(results.length === 1) {
                            let oneResultLogin = results[0];
                            // 세션 테이블에 데이터 저장
                            req.session.authenticate = true;
                            req.session.user = {
                                user_name: oneResultLogin.user_name,
                                login_id: oneResultLogin.login_id,
                                userinfo_userId: oneResultLogin.userinfo_userId,
                                group_type: oneResultLogin.group_type,
                                group_manager: oneResultLogin.group_manager,
                                user_type: oneResultLogin.user_type,
                                org_name: oneResultLogin.org_name,
                                org_id: oneResultLogin.org_id,
                                service_type: oneResultLogin.userinfo_serviceType,
                                userinfo_uuid: uuid,
                                cusinfo_uuid: uuid2,
                                current_path: ''
                            };
                            sessionUser = req.session.user;
        
                            // 로그인 이력 저장
                            let login_history_sql = `INSERT INTO emo_loginout_info (loginout_dt, userinfo_userid, login_id, group_manager, user_name, loginout_type, uuid, uuid2)
                            VALUES (NOW(3), '${req.session.user.userinfo_userId}', '${req.session.user.login_id}', '${req.session.user.group_manager}', '${req.session.user.user_name}', 'I', '${req.session.user.userinfo_uuid}', '${req.session.user.cusinfo_uuid}')`;
        
                            connection.query(login_history_sql, (err) => {
                                if (err) {
                                    logger.error(`[ API:login_info_sql ] ${err}`);
                                    throw err;
                                }
                                logger.info(`[ app.js:login_info_sql ] ${login_history_sql}`);
                                logger.info(`[ app:login_info_sql ] * User login success & Data inserted! *`);
                                logger.info(`[ app:login_info_sql ] 현재 접속한 사용자 정보\n${JSON.stringify(sessionUser, null, 2)}`);
        
                                //  erkServiceConn_send_dt는 로그인 시 전송하는걸로
                                let erkconn_send_rq = `UPDATE emo_user_info SET erkserviceconn_send_dt = NOW(3) 
                                WHERE login_id = "${req.session.user.login_id}";`;
                                connection.query(erkconn_send_rq, async (err, results) => {
                                    if (error) {
                                        logger.error(`[ app:erkconn_send_rq ] ${err}`);
                                        connection.end();
                                    }
                                    logger.info(`[ app:erkconn_send_rq ] ${erkconn_send_rq}`);

                                    //  상담원 로그인
                                    let ErkMsgHead = ErkApiMsg.create({
                                        MsgType: 17,    // v3.3: 17, 전시회:13
                                        QueueInfo: ErkQueueInfo,
                                        TransactionId: sessionUser.userinfo_uuid,
                                        OrgId: req.session.user.org_id,
                                        UserId: sessionUser.userinfo_userId
                                    });

                                    let ErkSrvcMsg = ErkApiMsg.create({
                                        ErkServiceConnRQ: {
                                            ErkMsgHead: ErkMsgHead,
                                            MsgTime: DateUtils.getCurrentTimestamp() // 년월일시분초밀리초
                                        }
                                    });
                                    let ErkSrvcMsg_buf = ErkApiMsg.encode(ErkSrvcMsg).finish();
                                    ch.sendToQueue("ERK_API_QUEUE", ErkSrvcMsg_buf);

                                    //  매핑된 고객 계정도 연결
                                    let ErkMsgHead_cus = ErkApiMsg.create({
                                        MsgType: 17,
                                        QueueInfo: ErkQueueInfo2,
                                        TransactionId: sessionUser.cusinfo_uuid,
                                        OrgId: req.session.user.org_id,
                                        UserId: sessionUser.userinfo_userId + 10
                                    });

                                    let ErkSrvcMsg_cus = ErkApiMsg.create({
                                        ErkServiceConnRQ: {
                                            ErkMsgHead: ErkMsgHead_cus,
                                            MsgTime: DateUtils.getCurrentTimestamp() // 년월일시분초밀리초
                                        }
                                    });

                                    let ErkSrvcMsg_buf_cus = ErkApiMsg.encode(ErkSrvcMsg_cus).finish();
                                    ch2.sendToQueue("ERK_API_QUEUE", ErkSrvcMsg_buf_cus);

                                    logger.info(`[ AMQP:sendToqueue ] 메세지 송신 결과\n${JSON.stringify(ErkSrvcMsg, null, 4)}`);
                                    logger.info(`[ AMQP:sendToqueue ] 메세지 송신 결과\n${JSON.stringify(ErkSrvcMsg_cus, null, 4)}`);
    
                                    if (req.session.user.group_manager === 'Y') {
                                        logger.info(`[ app:erkconn_send_rq ] 관리자 페이지로 이동`);
                                        res.redirect(301, '/workStatusMain');
                                    } else {
                                        logger.info(`[ app:erkconn_send_rq ] 상담원 페이지로 이동`);
                                        res.redirect(301, `/consultant`);
                                    }
        
                                    // 변수 초기화
                                    ErkSrvcMsg = null;
                                    ErkSrvcMsg_buf = null;
                                    ErkMsgHead = null;
        
                                    return;
                                });
                            });
                        } else {
                            res.send(`<script type="text/javascript">
                            alert("등록된 사용자가 아닙니다. 관리자에게 문의해주세요.");
                            document.location.href="/";</script>`);
                        }
                    });
                }
            });

            //   3.9.2 서비스 연결 해제 요청 및 처리
            //    - 사용자 로그아웃
            app.get(`/logout`, (req, res) => {
                logger.info(`[ API:ManagerLogout ] 로그아웃 프로세스 호출`);

                const userId = req.session.user.login_id;

                //  세션이 인증된 상태라면
                if (req.session.authenticate) {
                    let logout_chk_qry = `SELECT *
                    FROM emo_user_info a
                    LEFT JOIN emo_provider_info b
                    ON a.org_name = b.org_name
                    WHERE a.user_name = "${req.session.user.user_name}"
                    AND a.login_id = "${userId}";`;

                    let logout_sql = `INSERT INTO emo_loginout_info (loginout_dt, userinfo_userid, login_id, group_manager, user_name, loginout_type, uuid, uuid2) 
                    VALUES (NOW(3), '${req.session.user.userinfo_userId}', '${userId}', '${req.session.user.group_manager}', '${req.session.user.user_name}', 'O',
                    '${req.session.user.userinfo_uuid}', '${req.session.user.cusinfo_uuid}')`;

                    if(req.session.userinfo_uuid === null || req.session.userinfo_uuid === '') {
                        req.session.userinfo_uuid === ""
                    }

                    connection.query(logout_chk_qry, (err, results) => {
                        if (err) {
                            logger.error(`[ API:logout_chk_qry ] ${err}`);
                            connection.end();
                        }
                        
                        if (results.length === 1) {
                            // 로그아웃을 요청한 사용자에 대해 erkServiceDisconnRQ 전송
                            let ErkMsgHead = ErkApiMsg.create({
                                MsgType: 19,    // v3.3: 19, 전시회: 13
                                TransactionId: req.session.userinfo_uuid,
                                QueueInfo: ErkQueueInfo,
                                OrgId: results[0].org_id,
                                UserId: results[0].userinfo_userId
                            });

                            let ErkMsgHead_cus = ErkApiMsg.create({
                                MsgType: 19,
                                TransactionId: req.session.cusinfo_uuid,
                                QueueInfo: ErkQueueInfo2,
                                OrgId: results[0].org_id,
                                UserId: results[0].userinfo_userId + 10
                            });

                            //  상담원 메세지 body
                            let ErkSrvcDisConnMsg = ErkApiMsg.create({
                                ErkServiceDisConnRQ: {
                                    ErkMsgHead: ErkMsgHead,
                                    MsgTime: parseInt(DateUtils.getCurrentTimestamp()), // 년월일시분초밀리초
                                    ServiceType: req.session.user.service_type
                                }
                            });
                            let ErkSrvcDisConnMsg_buf = ErkApiMsg.encode(ErkSrvcDisConnMsg).finish();

                            //  고객 메세지 body
                            let ErkSrvcDisConnMsg_cus = ErkApiMsg.create({
                                ErkServiceDisConnRQ: {
                                    ErkMsgHead: ErkMsgHead_cus,
                                    MsgTime: parseInt(DateUtils.getCurrentTimestamp()), // 년월일시분초밀리초
                                    ServiceType: req.session.user.service_type
                                }
                            });
                            let ErkSrvcDisConnMsg_buf_cus = ErkApiMsg.encode(ErkSrvcDisConnMsg_cus).finish();

                            let erkDisconn_send_rq = `UPDATE emo_user_info
                            SET erkservicedisconn_send_dt = NOW(3)
                            WHERE user_name = "${req.session.user.user_name}"
                            AND userinfo_userId = ${req.session.user.userinfo_userId};`
                            connection.query(logout_sql, err => {
                                if (err) {
                                    logger.error(`[ API:logout_sql ] ${err}`);
                                    throw err;
                                }
                                
                                // DB 업데이트 및 송신
                                connection.query(erkDisconn_send_rq, (err, results) => {
                                    if (err) {
                                        logger.error(`[ API:erkDisconn_send_rq ] ${err}`);
                                        throw err;
                                    }

                                    ch.sendToQueue("ERK_API_QUEUE", ErkSrvcDisConnMsg_buf);
                                    ch2.sendToQueue("ERK_API_QUEUE", ErkSrvcDisConnMsg_buf_cus);

                                    logger.info(`[ AMQP:sendToqueue ] 메세지 송신 결과\n${JSON.stringify(ErkSrvcDisConnMsg, null, 4)}`);
                                    logger.info(`[ AMQP:sendToqueue ] 메세지 송신 결과\n${JSON.stringify(ErkSrvcDisConnMsg_cus, null, 4)}`);

                                    // 변수 초기화
                                    ErkSrvcDisConnMsg = null;
                                    ErkSrvcDisConnMsg_buf = null;
                                    ErkMsgHead = null;

                                    // loginIDsArr를 순회하며 해당 socket.id를 가진 사용자를 찾습니다.
                                    for (let [key, value] of loginIDsArr) {
                                        if ( value.id === `${userId}`) {
                                            loginIDsArr.delete(userId);
                                            req.session;
                                            logger.info(`[ API:erkDisconn_send_rq ] 세션 삭제 성공, 현재 사용자 수: ${loginIDsArr.size}명`);

                                            break;
                                        }
                                    }

                                    res.redirect(`/`);
                                });

                                req.session.destroy((err) => {
                                    if (err) {
                                        logger.error(`[ API:logout_sql ] 세션 삭제 오류\n${err}`);
                                        return false;
                                    } else {
                                        logger.info(`[ API:ManagerLogout ] User logout success & Data updated!`);
                                        return true;
                                    }
                                });
                            });
                        } else {
                            logger.warn(`[ API:ManagerLogout ] 검색 결과 없음`);
                        }
                    });
                } else {
                    logger.info('[ API:ManagerLogout ] 로그인 상태 아님');

                    res.redirect('/login');
                }
            });
        
            //  4.  관리자 수동 코칭
            app.post('/sendingCoaching', (req, res) => {
                //  세션 체크
                if (!req.session || !req.session.authenticate || !req.session.user) {
                    logger.info(`[ app.js:/manageCoachingSending ] 세션 정보가 없거나 인증되지 않아 로그인 페이지로 이동`);
                    res.redirect(`/`, { title: `로그인` });
                }
        
                let testChk = req.body;
                logger.info(testChk);
        
                // 코칭 메세지, 특이사항, 코칭 기준시간
                let coach_msg = req.body.getMsgDetail;
                let coach_standard = req.body.getTimeRange;
                let coach_name = req.body.getLoginId;
                let coach_seqNo = req.body.getSeqNo;
                let coach_time = req.body.getCallTime;
                let coach_date = req.body.getCallDate;
        
                logger.info(`[ app.js:/manageCoachingSending ] 수동 코칭 메세지 내용 : ** ${coach_msg} **`);
                for(let num in loginIDsArr) {
                    if (loginIDsArr[num]['id'] == coach_name) {
                        logger.info(`[ app.js:/manageCoachingSending ] 전달 할 상담원 이름 : ** ${loginIDsArr[num]['user']} **`);
                    } else {
                        logger.info(`[ app.js:/manageCoachingSending ] 해당 상담원 접속 중 아님`);
                    }
                }
                logger.info(`[ app.js:/manageCoachingSending ] 기준 시간 : ** ${coach_standard} **`);
        
                // socket 정보를 매핑하여 특정 클라이언트에게 전송  
                for (let num in loginIDsArr) {
                    if (loginIDsArr[num]['id'] == coach_name) {
                        logger.info('[ app.js:/manageCoachingSending ] 해당 상담원 접속 중');
                        logger.info(`[ app.js:/manageCoachingSending ] 보낼 소켓 ID : ${loginIDsArr[num]['socket']}`);
        
                        let upt_pass_query = `UPDATE emo_coaching_message SET send_yn = 'Y'
                        WHERE login_id = '${coach_name}'
                        AND auto_seq = ${coach_seqNo}
                        AND call_date = DATE_FORMAT('${coach_date}', '%Y-%m-%d')
                        AND call_time = '${coach_time}'
                        AND auto_standard = 30
                        AND auto_coach = 'P';`;
        
                        // 소켓을 통해 메세지 전송
                        io.to(loginIDsArr[num]['socket']).emit('admin_msg', ` ──────────────── [관리자 메세지] ────────────────
        ** ${loginIDsArr[num]['user']}님! 관리자로부터 메세지가 도착했습니다. **
        "${coach_msg}" (${DateUtils.getCurrentDate()});
        ────────────────────────────────────────`);
        
                        try {
                            connection.query(upt_pass_query, (err, result) => {
                                if (err) {
                                    logger.error(`[ app.js:/manageCoachingSending ] ${err}`);
                                    connection.end();
                                }
        
                                logger.info(`[ app.js:/manageCoachingSending ] 상담 코칭, 특이 사항 쿼리\n${upt_pass_query}`);
                                logger.info(`[ app.js:/manageCoachingSending ] 쿼리 결과 : ${JSON.stringify(result)}`);
                            });
        
                            //  성공 res.send는 string, object, array 등을 보낼 수 있다. int형은 안됌
                            return res.status(200).json({ message: "메세지가 성공적으로 전송되었습니다." });
                        } catch(err) {
                            logger.error('Error saving data:', err);
                            res.status(500).json({ err: '서버 오류가 발생했습니다.' });
                        }
                    } else {
                        logger.info('[ app.js:/manageCoachingSending ] 접속중인 상담사가 아닙니다');
        
                        //  응답 전송
                        return res.status(200).json({ message: "해당 상담사는 현재 접속중인 상태가 아닙니다." });
                    }
                }
            });

            //   3.10.1 EmoServiceStart
            app.get(`/EmoServiceStartRQ`, async (req, res) => {
                logger.info(`[ app.js:EmoServiceStartRQ ] EmoServiceStartRQ 프로세스 호출`);

                try {
                    if(req.session.authenticate) {
                        //  ESSRQ 메세지 헤더 구성
                        let ErkMsgHead = ErkApiMsg.create({
                            MsgType: 21,
                            TransactionId: sessionUser.userinfo_uuid,
                            QueueInfo: ErkQueueInfo,
                            OrgId: req.session.user.org_id,
                            UserId: req.session.user.userinfo_userId
                        });
                        let ErkMsgHead_cus = ErkApiMsg.create({
                            MsgType: 21,
                            TransactionId: sessionUser.cusinfo_uuid,
                            QueueInfo: ErkQueueInfo2,
                            OrgId: req.session.user.org_id,
                            UserId: req.session.user.userinfo_userId+10  // 상담원15명 셋팅(고객은 +15 로 매핑)
                        });

                        let EmoServiceStartMsg = ErkApiMsg.create({
                            EmoServiceStartRQ: {
                                ErkMsgHead: ErkMsgHead,
                                EmoRecogType: 1,    // 개인감성 or 사회감성
                                MsgTime: DateUtils.getCurrentTimestamp(), // 년월일시분초밀리초
                                ServiceType: req.session.user.service_type
                            }
                        });
                        let EmoServiceStartMsg_cus = ErkApiMsg.create({
                            EmoServiceStartRQ: {
                                ErkMsgHead: ErkMsgHead_cus,
                                EmoRecogType: 1,    // 개인감성 or 사회감성
                                MsgTime: DateUtils.getCurrentTimestamp(), // 년월일시분초밀리초
                                ServiceType: req.session.user.service_type
                            }
                        });
                        let EmoServiceStartMsg_buf = ErkApiMsg.encode(EmoServiceStartMsg).finish();
                        let EmoServiceStartMsg_buf_cus = ErkApiMsg.encode(EmoServiceStartMsg_cus).finish();
    
                        let emoSerStart_send_rq = `UPDATE emo_user_info
                        SET erkEmoSrvcStart_send_dt = NOW(3)
                        WHERE userinfo_userId = ${req.session.user.userinfo_userId}
                        AND userinfo_userId = ${req.session.user.userinfo_userId + 10};`;
    
                        connection.query(emoSerStart_send_rq, (err, results) => {
                            if (err) {
                                logger.error(`[ app.js:EmoServiceStartRQ ] ${err}`);
                                connection.end();
                            }
                            logger.info(`[ app.js:EmoServiceStartRQ ] 업데이트 후 메세지 송신\n${JSON.stringify(EmoServiceStartMsg, null, 4)}`);
                            logger.info(`[ app.js:EmoServiceStartRQ ] 업데이트 후 메세지 송신\n${JSON.stringify(EmoServiceStartMsg_cus, null, 4)}`);

                            ch.sendToQueue("ERK_API_QUEUE", EmoServiceStartMsg_buf);
                            ch2.sendToQueue("ERK_API_QUEUE", EmoServiceStartMsg_buf_cus);
                        });

                        res.status(200).json({ message:`[ app.js:EmoServiceStartRQ ] API 정상처리` });
                    } else {
                        logger.info('[ API:EmoServiceStartRQ ] 로그인 상태 아님');
                        res.redirect('/login');
                    }
                } catch(err) {
                    logger.error(`[ app.js:EmoServiceStartRQ ] ${err}`);
                    res.status(500).json({ message:`[ app.js:EmoServiceStartRQ ] API 오류 발생`});
                }
            });

            //   EmoServiceStop
            app.get(`/EmoServiceStopRQ`, async (req, res) => {
                logger.info(`[ app.js:EmoServiceStopRQ ] EmoServiceStopRQ 프로세스 호출`);

                try{
                    let select_engine_info = `SELECT * FROM emo_user_info
                    WHERE userinfo_userId IN (${req.session.user.userinfo_userId}, ${req.session.user.userinfo_userId + 10})`;

                    if(req.session.authenticate) {
                        connection.query(select_engine_info, (err, results) => {
                            if(err) {
                                logger.error(`[ app.js:EmoServiceStopRQ ] ${err}`);
                                return null;
                            }
                            logger.info(`[ app.js:EmoServiceStopRQ ] 조회 결과 ${results.length}건`);

                            if (results.length > 0) {
                                //  상담원
                                let ErkMsgHead = ErkApiMsg.create({
                                    MsgType: 23,
                                    TransactionId: sessionUser.userinfo_uuid,
                                    QueueInfo: ErkQueueInfo,
                                    OrgId: req.session.user.org_id,
                                    UserId: req.session.user.userinfo_userId
                                });

                                let EmoServiceStopMsg = ErkApiMsg.create({
                                    EmoServiceStopRQ: {
                                        ErkMsgHead: ErkMsgHead,
                                        EmoRecogType: 1,    // 개인감성 or 사회감성
                                        MsgTime: DateUtils.getCurrentTimestamp(), // 년월일시분초밀리초
                                        ServiceType: sessionUser.service_type,
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
                                let EmoServiceStopMsg_buf = ErkApiMsg.encode(EmoServiceStopMsg).finish();

                                //  고객
                                let ErkMsgHead_cus = ErkApiMsg.create({
                                    MsgType: 23,
                                    TransactionId: sessionUser.cusinfo_uuid,
                                    QueueInfo: ErkQueueInfo2,
                                    OrgId: req.session.user.org_id,
                                    UserId: req.session.user.userinfo_userId + 10
                                });

                                let EmoServiceStopMsg_cus = ErkApiMsg.create({
                                    EmoServiceStopRQ: {
                                        ErkMsgHead: ErkMsgHead_cus,
                                        EmoRecogType: 1,    // 개인감성 or 사회감성
                                        MsgTime: DateUtils.getCurrentTimestamp(), // 년월일시분초밀리초
                                        ServiceType: sessionUser.service_type,
                                        PhysioEngine_ReceiveQueueName: "",
                                        PhysioEngine_SendQueueName: "",
                                        SpeechEngine_ReceiveQueueName: `${results[1].erkengineInfo_returnCustomer_recvQueueName}`,
                                        SpeechEngine_SendQueueName: `${results[1].erkengineInfo_returnCustomer_sendQueueName}`,
                                        FaceEngine_ReceiveQueueName: "",
                                        FaceEngine_SendQueueName: "",
                                        KnowledgeEngine_ReceiveQueueName: "",
                                        KnowledgeEngine_SendQueueName: "",
                                    }
                                });
                                let EmoServiceStopMsg_buf_cus = ErkApiMsg.encode(EmoServiceStopMsg_cus).finish();

                                let emoSerStop_send_rq = `UPDATE emo_user_info
                                SET erkEmoSrvcStop_send_dt = NOW(3)
                                WHERE userinfo_userId IN(${req.session.user.userinfo_userId}, ${req.session.user.userinfo_userId+10});`;

                                connection.query(emoSerStop_send_rq, (err, results) => {
                                    if (err) {
                                        logger.error(`[ app.js:emoSerStop_send_rq ] ${err}`);
                                        return null;
                                    }
                                    logger.info(`[ app.js:emoSerStop_send_rq ] 업데이트 후 메세지 송신\n${JSON.stringify(EmoServiceStopMsg, null, 4)}`);
                                    logger.info(`[ app.js:emoSerStop_send_rq ] 업데이트 후 메세지 송신\n${JSON.stringify(EmoServiceStopMsg_cus, null, 4)}`);
                                    
                                    ch.sendToQueue("ERK_API_QUEUE", EmoServiceStopMsg_buf);
                                    ch2.sendToQueue("ERK_API_QUEUE", EmoServiceStopMsg_buf_cus);
                                });
    
                                res.status(200).json({ message:`[ app.js:EmoServiceStopRQ ] API 정상처리` });
                            }
                        });
                    } else {
                        logger.info('[ API:EmoServiceStopRQ ] 로그인 상태 아님');
                        res.redirect('/login');
                    }
                } catch(err) {
                    logger.error(`[ app.js:EmoServiceStopRQ ] ${err}`);
                    res.status(500).json({ message:`[ app.js:EmoServiceStopRQ ] API 오류` });
                }
            });

            //   - SpeechEmoRecogRQ(음성감성인지요구)
            app.get('/SpeechEmoRecogRQ', async (req, res) => {
                try {
                    logger.info('[ app.js:SpeechEmoRecogRQ ] SpeechEmoRecogRQ API 호출');
            
                    const getWavFilepath = path.join(__dirname, 'demo_files', '20230823142311201_A_2501.wav');
                    // const getWavFilepath = path.join(__dirname, '3_demo_files', 'test1.wav');
            
                    const sessionUserQry = `
                        SELECT a.*, b.*
                        FROM emo_user_info a
                        LEFT JOIN emo_provider_info b ON a.org_name = b.org_name
                        WHERE a.login_id = ? OR a.userinfo_userId = ?
                    `;
            
                    const sessionUser = await new Promise((resolve, reject) => {
                        connection.query(sessionUserQry, [req.session.user.login_id, req.session.user.userinfo_userId + 10], (err, results) => {
                            if (err) {
                                logger.error(`[ app.js:SpeechEmoRecogRQ ] ${err}`);
                                reject(err);
                            }
                            resolve(results[0]);
                        });
                    });
            
                    if (!sessionUser) { throw new Error('[ app.js:SpeechEmoRecogRQ ] 사용자 정보를 찾을 수 없습니다.'); }
            
                    // sendAudioChunks의 결과를 받아 처리
                    const result = await sendAudioChunksT(getWavFilepath, sessionUser);
                    logger.info(`[ app.js:SpeechEmoRecogRQ ] sendAudioChunks 결과:`, result);
            
                    if (result.success) {
                        res.status(200).json({ message: '[ app.js:SpeechEmoRecogRQ ] 파일 처리 성공', details: result.message });
                    } else {
                        // 성공하지 못한 경우에도 200 상태 코드를 반환하되, success: false로 표시
                        res.status(200).json({ success: false, message: '[ app.js:SpeechEmoRecogRQ ] 파일 처리 중 일부 실패', details: result.message });
                    }
                } catch (err) {
                    logger.error(`[ app.js:SpeechEmoRecogRQ ] ${err}`);
                    res.status(500).json({ message: '[ app.js:SpeechEmoRecogRQ ] Internal Server Error', details: err.message });
                }
            });

            //  5. 메세지 수신
            //   5.1. prefetch(n)를 설정하면 큐에서 최대 n개까지 가져감
            //    * 메세지를 처리하는 속도가 빠르고, 하나의 큐에 적은 consumer가 있으면 high
            //    *                          ""                  많은 consumer가 있으면 middle
            //    * 메세지를 처리하는 속도가 느리면 1
            //      예를 들어, Prefetch가 250일 경우, RabbitMQ는 250개의 메세지까지 한번에 Listener의 메모리에 Push
            //    * prefetch 값 계산
            //      - prefetch = (메시지 처리 시간 * 초당 메세지 수) * 안전계수
            //   * 큐에 전달된 메시지를?비동기식으로 처리하며?여러 개의 메시지를 한번에 consume 할 수 있음.
            //   * get()보다 성능적으로 우수
            ch.prefetch(22);
            ch.consume(chName, async (msg) => {
                //  응답 메세지의 CONTENT 가져옴
                let recvMsg = ErkApiMsg.decode(msg.content);

                // recvMsg의 이름으로 분류
                switch (Object.keys(recvMsg).toString()) {
                    //  사업자 관련 인터페이스
                    case 'AddServiceProviderInfoRP':
                        logger.info(`[ RMQ:AddServiceProviderInfoRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);

                        // result_type == `OrgProfileResult_ok` or 1이면 사용자 프로파일링 진행
                        if(recvMsg.AddServiceProviderInfoRP.ResultType == 1 || recvMsg.AddServiceProviderInfoRP.ResultType == `OrgProfileResult_ok`) {
                            let upt_srvc_provider = `UPDATE emo_provider_info
                            SET result_type = "${recvMsg.AddServiceProviderInfoRP.ResultType}",
                                org_id = "${recvMsg.AddServiceProviderInfoRP.OrgId}",
                                recv_dt = NOW(3),
                                update_dt = NOW(3)
                            WHERE org_name = "${recvMsg.AddServiceProviderInfoRP.OrgName}"`;

                            connection.query(upt_srvc_provider, (err, results) => {
                                if(err) {
                                    logger.error(`[ RMQ:upt_srvc_provider ] ${err}`);
                                    connection.end();
                                }
                                logger.info(`[ RMQ:upt_srvc_provider ] 사업자 등록 정보 업데이트 성공`);

                                //  3.4.1. 사용자 등록
                                let select_add_usr_info = `SELECT
                                    a.org_name,
                                    a.userinfo_userId,
                                    a.user_name,
                                    a.login_id,
                                    a.login_pw,
                                    b.service_duration,
                                    a.age,
                                    a.sex,
                                    a.mbti_type,
                                    a.user_type,
                                    a.group_manager,
                                    a.group_type,
                                    a.userinfo_send_dt,
                                    a.userinfo_recv_dt,
                                    a.userinfo_userId,
                                    a.userinfo_return_code,
                                    b.service_type
                                FROM emo_user_info a
                                LEFT JOIN emo_provider_info b
                                ON a.org_name = b.org_name 
                                WHERE b.org_id IS NOT NULL
                                AND a.userinfo_userId IS NULL
                                AND b.org_name = ${recvMsg.AddServiceProviderInfoRP.OrgName};`;

                                connection.query(select_add_usr_info, (err, results) => {
                                    if(err) {
                                        logger.error(`[ AMQP:addUserInfo ] ${err}`);
                                        connection.end();
                                    }
                                    logger.info(`[ AMQP:addUserInfo ] 사용자 등록 조회 결과 : ${results.length}건`);

                                    //  조회 결과 0건
                                    if(results.length === 0) {
                                        logger.info(`[ AMQP:addUserInfo ] 등록할 사용자 없음`);
                                    } else {
                                        //  조회 결과 0건 이상
                                        logger.info(`[ AMQP:addUserInfo ] 상담원 등록 인터페이스 ${results.length}건 진행`);
                                        
                                        results.forEach(user => {
                                            let addUsrMsg = ErkApiMsg.create({
                                                AddUserInfoRQ: {
                                                    MsgType: 7,
                                                    QueueInfo: ErkQueueInfo,
                                                    OrgName: user.org_name,
                                                    UserName: user.login_id,
                                                    UserPwd: user.login_pw,
                                                    ServiceDuration: user.service_duration,
                                                    Age: user.age,
                                                    Sex: user.sex,
                                                    MbtiType: user.mbti_type,
                                                    UserType: user.user_type,
                                                    ServiceType: user.service_type
                                                }
                                            });

                                            let addUsrMsg_buf2 = ErkApiMsg.encode(addUsrMsg).finish();
                                            let upt_add_usr_info = `UPDATE emo_user_info SET update_dt = NOW(3), userinfo_send_dt = NOW(3) WHERE login_id = "${user.login_id}"`;

                                            // 전송 이력 DB 저장 후 메세지 송신
                                            connection.query(upt_add_usr_info, (err, results) => {
                                                if(err) {
                                                    logger.error(`[ AMQP:upt_addUsr_info ] ${err}`);
                                                    connection.end();
                                                }

                                                ch.sendToQueue("ERK_API_QUEUE", addUsrMsg_buf2);
                                                logger.info(`[ AMQP:sendToqueue ] 송신한 메세지\n${JSON.stringify(addUsrMsg, null, 4)}`);
                                            });

                                            addUsrMsg = null;
                                            addUsrMsg_buf2 = null;
                                            upt_add_usr_info = null;
                                        });
                                    }
                                });
                            });
                        } else {  // 전달받은 결과 메세지 DB에 저장(Return result 상태가 _nok_ 포함이면 재전송 상황)
                            let upt_srvc_provider_nok = `UPDATE emo_provider_info
                            SET org_name = "${recvMsg.AddServiceProviderInfoRP.OrgName}",
                                org_pwd =  "${recvMsg.AddServiceProviderInfoRP.OrgPwd}",
                                service_duration = "${recvMsg.AddServiceProviderInfoRP.ServiceDuration}", 
                                user_number = "${recvMsg.AddServiceProviderInfoRP.UserNumber}", 
                                result_type = "${recvMsg.AddServiceProviderInfoRP.ResultType}", 
                                recv_dt = NOW(3), 
                                update_dt = NOW(3)
                            WHERE org_name = "${recvMsg.AddServiceProviderInfoRP.OrgName}"`;

                            connection.query(upt_srvc_provider_nok, (err, result) => {
                                if (err) {
                                    logger.error(`[ RMQ:upt_srvc_provider ] ${err}`);
                                    connection.end();
                                }
                                logger.info(`[ RMQ:upt_srvc_provider ] noK 정보 업데이트 성공. 사업자 등록 재요청 시작`)

                                //  사업자 등록 재요청
                                let re_add_provider_query = `SELECT * FROM emo_provider_info WHERE org_id IS NULL;`
                                connection.query(re_add_provider_query, (err, results) => {
                                    if (err) {
                                        logger.error(`[ AMQP:re_add_provider_query ] ${err}`);
                                        connection.end();
                                    }
                                    logger.info(`[ AMQP:re_add_provider_query ] 재요청해야 할 서비스 항목 ${results.length}건`);

                                    for(let i=0; i<results.length; i++) {
                                        let addSrvcMsg = ErkApiMsg.create({
                                            AddServiceProviderInfoRQ: {
                                                MsgType: 1,
                                                QueueInfo: ErkQueueInfo,
                                                OrgName: results[i].org_name,
                                                OrgPwd: results[i].org_pwd,
                                                ProviderType: results[i].provider_type,
                                                ServiceDuration: results[i].service_duration,
                                                UserNumber: results[i].user_number,
                                                ServiceType: results[i].service_type
                                            }
                                        });
                                        let addSrvcMsg_buf = ErkApiMsg.encode(addSrvcMsg).finish();
                
                                        // 사업자 등록 요청 데이터 저장 SQL
                                        let upt_add_provider = `UPDATE emo_provider_info
                                        SET org_name = "${results[i].org_name}",
                                            org_pwd =  "${results[i].org_pwd}",
                                            service_duration = "${DateUtils.getYearMonthDay()}", 
                                            user_number = ${results[i].user_number}, 
                                            service_type = ${results[i].service_type},
                                            send_dt = NOW(3),
                                            insert_dt = NOW(3)
                                        WHERE org_name = "${results[i].org_name}";`;

                                        //  3.4.2. 사업자 등록 요청 전송
                                        connection.query(upt_add_provider, err => {
                                            if (err) {
                                                logger.error(`[ AMQP:uptProviderErr ] ${err}`);
                                                connection.end();
                                            }
                                            // 전송 이력 DB 저장 후 메세지 송신
                                            logger.info(`[ AMQP:sendToqueue ] 메세지 송신 결과\n${JSON.stringify(addSrvcMsg, null, 4)}`);

                                            ch.sendToQueue("ERK_API_QUEUE", addSrvcMsg_buf);

                                            addSrvcMsg = null;
                                            addSrvcMsg_buf = null;
                                            upt_add_provider = null;
                                        });
                                    }
                                });
                            });

                            recvMsg = null;
                        }

                        break;
                    case 'DelServiceProviderInfoRP':
                        logger.info(`[ RMQ:DelServiceProviderInfoRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);

                        break;
                    case 'UpdServiceProviderInfoRP':
                        logger.info(`[ RMQ:UpdServiceProviderInfoRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                        
                        break;
                    //  사용자 관련 인터페이스
                    case 'AddUserInfoRP':
                        logger.info(`[ RMQ:AddUserInfoRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                        
                        if(recvMsg.AddUserInfoRP.ResultType === 1 || recvMsg.AddUserInfoRP.ResultType === 10) {
                            // userinfo_return_code = '${recvMsg.AddUserInfoRP.ResultType}',
                            let upt_addUsrrp_info = `UPDATE emo_user_info
                            SET userinfo_return_code = 1,
                                userinfo_userId = "${recvMsg.AddUserInfoRP.UserId}",
                                user_type = "${recvMsg.AddUserInfoRP.UserType}",
                                userinfo_serviceType = "${recvMsg.AddUserInfoRP.ServiceType}",
                                userinfo_recv_dt = NOW(3),
                                insert_dt = NOW(3),
                                update_dt = NOW(3),
                                del_yn = null
                            WHERE org_name = "${recvMsg.AddUserInfoRP.OrgName}"
                            AND login_id = "${recvMsg.AddUserInfoRP.UserName}";`;

                            connection.query(upt_addUsrrp_info, (err, result) => {
                                if (err) {
                                    logger.error(`[ RMQ:upt_addUsrrp_info ] ${err}`);
                                    connection.end();
                                }

                                logger.info(`[ RMQ:upt_addUsrrp_info_ok ] 사용자 정보 업데이트 성공\n${upt_addUsrrp_info}`);
                            });

                            recvMsg = null;
                        } else {
                            let upt_addUsrrp_info_nok = `UPDATE emo_user_info
                            SET org_name = "${recvMsg.AddUserInfoRP.OrgName}",
                                userinfo_return_code = "${recvMsg.AddUserInfoRP.ResultType}",
                                login_pw = "${recvMsg.AddUserInfoRP.UserPwd}",
                                org_id = "${recvMsg.AddUserInfoRP.OrgId}",
                                userinfo_recv_dt = NOW(3),
                                update_dt = NOW(3)
                            WHERE org_name = "${recvMsg.AddUserInfoRP.OrgName}"
                            AND user_name = "${recvMsg.AddUserInfoRP.UserName}";`;

                            // nok로 인해 userinfo_userId를 받지 못한 사용자 재등록 요청
                            recvMsg = null;
                        }

                        break;
                    case 'DelUserInfoRP':
                        logger.info(`[ RMQ:DelUserInfoRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);

                        //  ok 응답이면
                        if(recvMsg.DelUserInfoRP.ResultType === 1 || recvMsg.DelUserInfoRP.Return === 'Success') {
                            let deletingUserSubmit_query = `UPDATE emo_user_info
                            SET del_yn = 'y', userinfo_userId = NULL
                            WHERE login_id = '${recvMsg.DelUserInfoRP.UserName}' AND del_yn = NULL`;

                            connection.query(deletingUserSubmit_query, (err, results) => {
                                if(err) {
                                    logger.error(`[ app.js:deletingUserSubmit_query ] ${err}`);
                                    connection.end();
                                }
                                logger.info(`[ app.js:deletingUserSubmit_query ] 사용자 삭제 성공`)
                            });
                        } else {
                            logger.info(`[ RMQ:DelUserInfoRP ] 다른 응답코드 받음`);
                        }
                        
                        break;
                    case 'UpdUserInfoRP':
                        logger.info(`[ RMQ:UpdUserInfoRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                        
                        break;
                    //  ERK 서비스 연결관련 인터페이스
                    case 'ErkServiceConnRP':
                        logger.info(`[ RMQ:ErkServiceConnRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);

                        let upt_erkSrvcConn_ok = `UPDATE emo_user_info
                        SET erkserviceconn_recv_dt = NOW(3),
                        erkserviceconn_return_code = '1' 
                        WHERE userinfo_userId = ${recvMsg.ErkServiceConnRP.ErkMsgHead.UserId}
                        AND userinfo_serviceType = ${recvMsg.ErkServiceConnRP.ServiceType}`;

                        connection.query(upt_erkSrvcConn_ok, (err, result) => {
                            if (err) {
                                logger.error(`[ Consume:ErkServiceConnRP ] ${err}`);
                                connection.end();
                            }
                            logger.info(`[ Consume:ErkServiceConnRP ] ReturnCode ok 업데이트 성공\n${upt_erkSrvcConn_ok}`);
                        });

                        recvMsg = null;

                        break;
                    case 'ErkServiceDisConnRP':
                        logger.info(`[ Consume:ErkServiceDisConnRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                        
                        if (recvMsg.ErkServiceDisConnRP.ReturnCode === 1 || recvMsg.ErkServiceDisConnRP.ReturnCode === `ReturnCode_ok`) {
                            let upt_erkSrvcConn_ok = `UPDATE emo_user_info
                            SET erkservicedisconn_recv_dt = NOW(3), 
                            erkservicedisconn_return_code = '${recvMsg.ErkServiceDisConnRP.ReturnCode}'
                            WHERE userinfo_userId = ${recvMsg.ErkServiceDisConnRP.ErkMsgHead.UserId}`;

                            connection.query(upt_erkSrvcConn_ok, (err, result) => {
                                if (err) {
                                    logger.error(`[ Consume:ErkServiceDisConnRP ] ${err}`);
                                    connection.end();
                                }

                                logger.info(`[ Consume:ErkServiceDisConnRP ] 사용자 정보 업데이트 성공\n${upt_erkSrvcConn_ok}`);
                            });

                            recvMsg = null;
                        } else {
                            logger.info(`[ Consume:ErkServiceDisConnRP ] 일단 다른 응답 처리`);
                            logger.info(`[ Consume:ErkServiceDisConnRP ] recvMsg.ErkServiceDisConnRP.ReturnCode: ${recvMsg.ErkServiceDisConnRP.ReturnCode}`);
                            
                            //  그 외의 응답 결과 저장
                            let upt_erkSrvcConn_nok = `UPDATE emo_user_info SET erkservicedisconn_recv_dt = NOW(3),
                            erkservicedisconn_return_code = '1' WHERE userinfo_userId = ${recvMsg.ErkServiceDisConnRP.ErkMsgHead.UserId}`;

                            connection.query(upt_erkSrvcConn_nok, (err, results) => {
                                if (err) {
                                    logger.error(`[ Consume:ErkServiceDisConnRP ] ${err}`);
                                    connection.end();
                                }

                                logger.info(`[ Consume:ErkServiceDisConnRP ] DB 업데이트 완료\n${upt_erkSrvcConn_nok}`);
                            });

                            recvMsg = null;
                        }

                        break;
                    //  감성인지 Erk 엔진 관련 인터페이스
                    case 'EmoServiceStartRP':
                        logger.info(`[ Consume:chEmoServiceStartRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);

                        try {
                            if (recvMsg.EmoServiceStartRP.ReturnCode === 1 || recvMsg.EmoServiceStartRP.ReturnCode === `ReturnCode_ok`) {
                                receiveQueueName = recvMsg.EmoServiceStartRP.SpeechEngineInfo.ReceiveQueueName;
                                sendQueueName = recvMsg.EmoServiceStartRP.SpeechEngineInfo.SendQueueName;
    
                                //  데이터 저장(receiveQueueName가 ERK로 보내기 위해 사용하는 큐 네임)
                                let upt_engine_info = `UPDATE emo_user_info
                                SET erkEmoSrvcStartRP_returnCode = '${recvMsg.EmoServiceStartRP.ReturnCode}',
                                    erkengineInfo_return_engineType = '${recvMsg.EmoServiceStartRP.SpeechEngineInfo.EngineType}',
                                    erkengineInfo_return_condition = '${recvMsg.EmoServiceStartRP.SpeechEngineInfo.EngineCondition}',
                                    erkengineInfo_return_ipAddr = '${recvMsg.EmoServiceStartRP.SpeechEngineInfo.IpAddr}',
                                    erkengineInfo_return_recvQueueName = '${receiveQueueName}',
                                    erkengineInfo_return_sendQueueName = '${sendQueueName}',
                                    update_dt = NOW(3),
                                    erkEmoSrvcStart_recv_dt = NOW(3)
                                WHERE userinfo_userId = ${recvMsg.EmoServiceStartRP.ErkMsgHead.UserId};`;
                                connection.query(upt_engine_info, (err, results) => {
                                    if (err) {
                                        logger.error(`[ Consume:chEmoServiceStartRP ] ${err}`);
                                        throw err;
                                    }

                                    logger.info(`[ Consume:chEmoServiceStartRP ] EmoServiceStartRP 수신 정보 업데이트 성공`);
                                });

                                //  Stream Queue 생성 함수 호출 (채널, EmoSrvcStartRP로 받은 ERK 큐, 현재 요청하는 세션 유저)
                                const getMyStreamQueueUser = recvMsg.EmoServiceStartRP.ErkMsgHead.UserId;
                                getMyStreamQueue(ch, receiveQueueName, getMyStreamQueueUser)
                                    .then(async (result) => {
                                        if (result.success) {
                                            logger.info(`[ app.js:getMyStreamQueue ] 스트림 큐 생성 성공`);

                                            //  전달받은 recvQueue 로 CH 메세지 소비
                                            ch.consume(`${sendQueueName}`, async (streamMsg) => {
                                                if(streamMsg !== null) {
                                                    //  응답 메세지의 content만 가져옴
                                                    let recvMsg = ErkApiMsg.decode(streamMsg.content);
                                                    
                                                    // recvMsg의 이름으로 분류
                                                    switch (Object.keys(recvMsg).toString()) {
                                                        //  감성 분석 인터페이스 response
                                                        case 'PhysioEmoRecogRP':
                                                            logger.info(`[ consume:PhysioEmoRecogRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                                                            break;
                                                        case 'SpeechEmoRecogRP':
                                                            logger.info(`[ consume:SpeechEmoRecogRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                                                            let SpeechEmoRecogTime_str = `${recvMsg.SpeechEmoRecogRP.EmoRecogTime}`;

                                                            if (recvMsg.SpeechEmoRecogRP.ReturnCode === 1 || recvMsg.SpeechEmoRecogRP.ReturnCode === `ReturnCode_ok`) {
                                                                try {
                                                                    //  현재 전송중인 음성 데이터 청크는 key값으로 순서를 구분해야 함
                                                                    const accuracy = isNaN(recvMsg.SpeechEmoRecogRP.Accuracy) ? 0 : Number(recvMsg.SpeechEmoRecogRP.Accuracy);

                                                                    let SpeechEmoRecogRP_qry = `UPDATE emo_emotion_info
                                                                    SET speechEmo_returnCode = '${recvMsg.SpeechEmoRecogRP.ReturnCode}',
                                                                        EmoRecogTime = '${SpeechEmoRecogTime_str}',
                                                                        emotion_type = ${recvMsg.SpeechEmoRecogRP.Emotion},
                                                                        accuracy = ${accuracy},
                                                                        recv_dt = NOW(3)
                                                                    WHERE userinfo_userId = ${recvMsg.SpeechEmoRecogRP.ErkMsgDataHead.UserId}
                                                                    AND send_dt = '${DateUtils.getCurrentDateTimeString(SpeechEmoRecogTime_str)}';`;

                                                                    logger.warn(`[ consume:SpeechEmoRecogRP ] 정상 응답\n${SpeechEmoRecogRP_qry}`);

                                                                    connection.query(SpeechEmoRecogRP_qry, (err, results) => {
                                                                        if (err) {
                                                                            logger.error(`[ consume:SpeechEmoRecogRP_qry ] ${err}`);
                                                                            return err
                                                                        }

                                                                        logger.info(`[ consume:SpeechEmoRecogRP_qry ] 업데이트 성공`);
                                                                    });
                                                                } catch (err) {
                                                                    logger.error(`[ consume:SpeechEmoRecogRP ] 데이터 처리 오류 ${err}`);
                                                                }
                                                            } else {
                                                                logger.error('[ consume:SpeechEmoRecogRP ] 다른 응답');

                                                                if (isNaN(recvMsg.SpeechEmoRecogRP.SpeechEngineInfo.Accuracy)) {
                                                                    recvMsg.SpeechEmoRecogRP.Accuracy = 0;
                                                                    recvMsg.SpeechEmoRecogRP.Emotion = 'EmotionType_unknown';
                                                                }

                                                                //  현재 전송중인 음원파일의 key는 datetime으로 매핑하여 구분
                                                                let SpeechEmoRecogRP_qry = `UPDATE emo_emotion_info
                                                                SET speechEmo_returnCode = '${recvMsg.SpeechEmoRecogRP.ReturnCode}',
                                                                    EmoRecogTime = '${recvMsg.SpeechEmoRecogRP.EmoRecogTime}',
                                                                    emotion_type = ${recvMsg.SpeechEmoRecogRP.Emotion},
                                                                    accuracy = ${Number(recvMsg.SpeechEmoRecogRP.Accuracy)},
                                                                    recv_dt = NOW(3)
                                                                WHERE userinfo_userId = ${recvMsg.SpeechEmoRecogRP.ErkMsgDataHead.UserId}
                                                                AND send_dt = '${DateUtils.getCurrentDateTimeString(recvMsg.SpeechEmoRecogRP.EmoRecogTime)}';`;

                                                                logger.warn(`[ consume:SpeechEmoRecogRP ] ${SpeechEmoRecogRP_qry}`);

                                                                connection.query(SpeechEmoRecogRP_qry, (err, results) => {
                                                                    if (err) {
                                                                        logger.error(`[ consume:SpeechEmoRecogRP_qry ] ${err}`);
                                                                        connection.end();
                                                                    }

                                                                    logger.info(`[ consume:SpeechEmoRecogRP_qry ] 업데이트 성공`);
                                                                });
                                                            }
                                                            
                                                            break;
                                                        case 'FaceEmoRecogRP':
                                                            logger.info(`[ consume:FaceEmoRecogRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                                                            break;
                                                        case 'EmoRecogRP':
                                                            logger.info(`[ consume:EmoRecogRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                                                            break;
                                                        //  기타
                                                        case 'ErkMsgType_reserved1':
                                                            logger.info(`[ consume:ErkMsgType_reserved1 ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                                                            break;
                                                        case 'ErkMsgType_reserved2':
                                                            logger.info(`[ consume:ErkMsgType_reserved2 ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                                                            break;
                                                        //  기본
                                                        default:
                                                            logger.warn(`[ consume:streamConsume ] 잘못된 메세지 형식 혹은 오류`);
                                                            return;
                                                    }

                                                    ch.ack(streamMsg);
                                                }
                                            },{
                                                // [ noAck: true ]: queue에서 데이터를 가져간 다음, ack를 바로 반환하면서 바로 해당 queue에서 메세지 삭제 
                                                // ack를 받았을 경우만 큐에서 제거하기 위해 false로 설정
                                                noAck: false
                                            });
                                        } else {
                                            logger.warn(`[ app.js:getMyStreamQueue ] 스트림 큐 생성 실패`);
                                            return null;
                                        }
                                    }).catch(err => {
                                        logger.error(`[ app.js:getMyStreamQueue ] ${err}`);
                                        return err;
                                    });
                            } else {
                                logger.info(`[ Consume:chEmoServiceStartRP ] recvMsg.EmoServiceStartRP.ReturnCode: ${recvMsg.EmoServiceStartRP.ReturnCode}`);
                                logger.info(`[ Consume:chEmoServiceStartRP ] recvMsg.EmoServiceStartRP.SpeechEngineInfo: ${recvMsg.EmoServiceStartRP.SpeechEngineInfo}`); // 값 안들어옴'

                                //  데이터 저장(receiveQueueName가 ERK로 보내기 위해 사용하는 큐 네임)
                                let upt_engine_info = `UPDATE emo_user_info
                                SET erkEmoSrvcStartRP_returnCode = '${recvMsg.EmoServiceStartRP.ReturnCode}',
                                    erkengineInfo_return_engineType = '${recvMsg.EmoServiceStartRP.SpeechEngineInfo.EngineType}',
                                    erkengineInfo_return_condition = '${recvMsg.EmoServiceStartRP.SpeechEngineInfo.EngineCondition}',
                                    erkengineInfo_return_ipAddr = '${recvMsg.EmoServiceStartRP.SpeechEngineInfo.IpAddr}',
                                    erkengineInfo_return_recvQueueName = '${receiveQueueName}',
                                    erkengineInfo_return_sendQueueName = '${sendQueueName}',
                                    update_dt = NOW(3),
                                    erkEmoSrvcStart_recv_dt = NOW(3)
                                WHERE userinfo_userId = ${recvMsg.EmoServiceStartRP.ErkMsgHead.UserId};`;

                                connection.query(upt_engine_info, (err, results) => {
                                    if (err) {
                                        logger.error(`[ Consume:chEmoServiceStartRP ] ${err}`);
                                        throw err;
                                    }
    
                                    logger.info(`[ Consume:chEmoServiceStartRP ] ${JSON.stringify(results, null, 4)}`);
                                });
    
                                return;
                            }
                        } catch(err) {
                            logger.error(`[ Consume:chEmoServiceStartRP ] Consume Error: ${err}`);
                            return;
                        }
                        
                        break;
                    case 'EmoServiceStopRP':
                        logger.info(`[ app.js:chEmoServiceStopRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);

                        try {
                            if (recvMsg.EmoServiceStopRP.ReturnCode === 1 || recvMsg.EmoServiceStopRP.ReturnCode === `ReturnCode_ok`) {                                
                                let EmoServiceStop_qry = `UPDATE emo_user_info
                                SET erkEmoSrvcStopRP_returnCode = '${recvMsg.EmoServiceStopRP.ReturnCode}',
                                    erkengineInfo_return_engineType = null,
                                    erkengineInfo_return_condition = null,
                                    erkengineInfo_return_ipAddr = null,
                                    erkengineInfo_return_recvQueueName = null,
                                    erkengineInfo_returnCustomer_recvQueueName = null,
                                    erkengineInfo_return_sendQueueName = null,
                                    erkengineInfo_returnCustomer_sendQueueName = null,
                                    update_dt = NOW(3),
                                    erkEmoSrvcStop_recv_dt = NOW(3)
                                WHERE userinfo_userId = ${recvMsg.EmoServiceStopRP.ErkMsgHead.UserId};`;

                                logger.info(`[ app.js:chEmoServiceStopRP ] ${EmoServiceStop_qry}`);

                                connection.query(EmoServiceStop_qry, (err, results) => {
                                    if (err) {
                                        logger.error(`[ app.js:chEmoServiceStopRP ] ${err}`);
                                        connection.end();
                                    }

                                    logger.info(`[ app.js:chEmoServiceStopRP ] 상태 업데이트 성공`);
                                });
                            } else {
                                logger.info(`[ app.js:chEmoServiceStopRP ] 다른 응답(정상)`);
                                
                                let EmoServiceStop_qry = `UPDATE emo_user_info
                                SET erkEmoSrvcStopRP_returnCode = '${recvMsg.EmoServiceStopRP.ReturnCode}',
                                    erkengineInfo_return_engineType = null,
                                    erkengineInfo_return_condition = null,
                                    erkengineInfo_return_ipAddr = null,
                                    erkengineInfo_return_recvQueueName = null,
                                    erkengineInfo_returnCustomer_recvQueueName = null,
                                    erkengineInfo_return_sendQueueName = null,
                                    erkengineInfo_returnCustomer_sendQueueName = null,
                                    update_dt = NOW(3),
                                    erkEmoSrvcStop_recv_dt = NOW(3)
                                WHERE userinfo_userId = ${recvMsg.EmoServiceStopRP.ErkMsgHead.UserId};`;

                                logger.info(`[ app.js:chEmoServiceStopRP ] ${EmoServiceStop_qry}`);

                                connection.query(EmoServiceStop_qry, (err, results) => {
                                    if (err) {
                                        logger.error(`[ app.js:chEmoServiceStopRP ] ${err}`);
                                        connection.end();
                                    }

                                    logger.info(`[ app.js:chEmoServiceStopRP ] 상태 업데이트 성공`);
                                });
                            }
                        } catch(err) {
                            logger.error(`[ app.js:chEmoServiceStopRP ] Error saving data ${err}`);
                        }

                        break;
                    //  기본
                    default:
                        logger.warn(`[ app.js:consumeDefault ] 잘못된 메세지 형식 혹은 오류`);
                        return;
                }

                ch.ack(msg); // 수신 확인 기능, 메세지를 성공적으로 수신하고 처리했다는 정보를 송신자(ETRI)에게 알려줌
            }, {
                // [noAck: true]면 queue에서 데이터를 가져간 다음, ack를 바로 반환하면서 바로 해당 queue에서 메세지 삭제 
                // ack를 받았을 경우만 큐에서 제거하기 위해 false로 설정
                noAck: false
            });

            ch2.prefetch(22);
            ch2.consume(chName_2, async (msg) => {
                //  응답 메세지의 CONTENT 가져옴
                let recvMsg = ErkApiMsg.decode(msg.content);

                // recvMsg의 이름으로 분류
                switch (Object.keys(recvMsg).toString()) {
                    //  사업자 관련 인터페이스
                    case 'AddServiceProviderInfoRP':
                        logger.info(`[ RMQ:AddServiceProviderInfoRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);

                        // result_type == `OrgProfileResult_ok` or 1이면 사용자 프로파일링 진행
                        if(recvMsg.AddServiceProviderInfoRP.ResultType == 1 || recvMsg.AddServiceProviderInfoRP.ResultType == `OrgProfileResult_ok`) {
                            let upt_srvc_provider = `UPDATE emo_provider_info
                            SET result_type = "${recvMsg.AddServiceProviderInfoRP.ResultType}",
                                org_id = "${recvMsg.AddServiceProviderInfoRP.OrgId}",
                                recv_dt = NOW(3),
                                update_dt = NOW(3)
                            WHERE org_name = "${recvMsg.AddServiceProviderInfoRP.OrgName}"`;

                            connection.query(upt_srvc_provider, (err, results) => {
                                if(err) {
                                    logger.error(`[ RMQ:upt_srvc_provider ] ${err}`);
                                    connection.end();
                                }
                                logger.info(`[ RMQ:upt_srvc_provider ] 사업자 등록 정보 업데이트 성공`);

                                //  3.4.1. 사용자 등록
                                let select_add_usr_info = `SELECT
                                    a.org_name,
                                    a.userinfo_userId,
                                    a.user_name,
                                    a.login_id,
                                    a.login_pw,
                                    b.service_duration,
                                    a.age,
                                    a.sex,
                                    a.mbti_type,
                                    a.user_type,
                                    a.group_manager,
                                    a.group_type,
                                    a.userinfo_send_dt,
                                    a.userinfo_recv_dt,
                                    a.userinfo_userId,
                                    a.userinfo_return_code,
                                    b.service_type
                                FROM emo_user_info a
                                LEFT JOIN emo_provider_info b
                                ON a.org_name = b.org_name 
                                WHERE b.org_id IS NOT NULL
                                AND a.userinfo_userId IS NULL;`;

                                connection.query(select_add_usr_info, (err, results) => {
                                    if(err) {
                                        logger.error(`[ AMQP:addUserInfo ] ${err}`);
                                        connection.end();
                                    }
                                    logger.info(`[ AMQP:addUserInfo ] 사용자 등록 조회 결과 : ${results.length}건`);

                                    //  조회 결과 0건
                                    if(results.length === 0) {
                                        logger.info(`[ AMQP:addUserInfo ] 등록할 사용자 없음`);
                                    } else {
                                        //  조회 결과 0건 이상
                                        logger.info(`[ AMQP:addUserInfo ] 상담원 등록 인터페이스 ${results.length}건 진행`);
                                        
                                        results.forEach(user => {
                                            let addUsrMsg = ErkApiMsg.create({
                                                AddUserInfoRQ: {
                                                    MsgType: 7,
                                                    QueueInfo: ErkQueueInfo,
                                                    OrgName: user.org_name,
                                                    UserName: user.login_id,
                                                    UserPwd: user.login_pw,
                                                    ServiceDuration: user.service_duration,
                                                    Age: user.age,
                                                    Sex: user.sex,
                                                    MbtiType: user.mbti_type,
                                                    UserType: user.user_type,
                                                    ServiceType: user.service_type
                                                }
                                            });

                                            let addUsrMsg_buf2 = ErkApiMsg.encode(addUsrMsg).finish();
                                            let upt_add_usr_info = `UPDATE emo_user_info SET update_dt = NOW(3), userinfo_send_dt = NOW(3) WHERE login_id = "${user.login_id}"`;

                                            // 전송 이력 DB 저장 후 메세지 송신
                                            connection.query(upt_add_usr_info, (err, results) => {
                                                if(err) {
                                                    logger.error(`[ AMQP:upt_addUsr_info ] ${err}`);
                                                    connection.end();
                                                }

                                                ch.sendToQueue("ERK_API_QUEUE", addUsrMsg_buf2);
                                                logger.info(`[ AMQP:sendToqueue ] 송신한 메세지\n${JSON.stringify(addUsrMsg, null, 4)}`);
                                            });

                                            addUsrMsg = null;
                                            addUsrMsg_buf2 = null;
                                            upt_add_usr_info = null;
                                        });
                                    }
                                });
                            });
                        } else {  // 전달받은 결과 메세지 DB에 저장(Return result 상태가 _nok_ 포함이면 재전송 상황)
                            let upt_srvc_provider_nok = `UPDATE emo_provider_info
                            SET org_name = "${recvMsg.AddServiceProviderInfoRP.OrgName}",
                                org_pwd =  "${recvMsg.AddServiceProviderInfoRP.OrgPwd}",
                                service_duration = "${recvMsg.AddServiceProviderInfoRP.ServiceDuration}", 
                                user_number = "${recvMsg.AddServiceProviderInfoRP.UserNumber}", 
                                result_type = "${recvMsg.AddServiceProviderInfoRP.ResultType}", 
                                recv_dt = NOW(3), 
                                update_dt = NOW(3)
                            WHERE org_name = "${recvMsg.AddServiceProviderInfoRP.OrgName}"`;

                            connection.query(upt_srvc_provider_nok, (err, result) => {
                                if (err) {
                                    logger.error(`[ RMQ:upt_srvc_provider ] ${err}`);
                                    connection.end();
                                }
                                logger.info(`[ RMQ:upt_srvc_provider ] noK 정보 업데이트 성공. 사업자 등록 재요청 시작`)

                                //  사업자 등록 재요청
                                let re_add_provider_query = `SELECT * FROM emo_provider_info WHERE org_id IS NULL;`
                                connection.query(re_add_provider_query, (err, results) => {
                                    if (err) {
                                        logger.error(`[ AMQP:re_add_provider_query ] ${err}`);
                                        connection.end();
                                    }
                                    logger.info(`[ AMQP:re_add_provider_query ] 재요청해야 할 서비스 항목 ${results.length}건`);

                                    for(let i=0; i<results.length; i++) {
                                        let addSrvcMsg = ErkApiMsg.create({
                                            AddServiceProviderInfoRQ: {
                                                MsgType: 1,
                                                QueueInfo: ErkQueueInfo,
                                                OrgName: results[i].org_name,
                                                OrgPwd: results[i].org_pwd,
                                                ProviderType: results[i].provider_type,
                                                ServiceDuration: DateUtils.getYearMonthDay(),
                                                UserNumber: results[i].user_number,
                                                ServiceType: results[i].service_type
                                            }
                                        });
                                        let addSrvcMsg_buf = ErkApiMsg.encode(addSrvcMsg).finish();
                
                                        // 사업자 등록 요청 데이터 저장 SQL
                                        let upt_add_provider = `UPDATE emo_provider_info
                                        SET org_name = "${results[i].org_name}",
                                            org_pwd =  "${results[i].org_pwd}",
                                            service_duration = "${DateUtils.getYearMonthDay()}", 
                                            user_number = ${results[i].user_number}, 
                                            service_type = ${results[i].service_type},
                                            send_dt = NOW(3),
                                            insert_dt = NOW(3)
                                        WHERE org_name = "${results[i].org_name}";`;

                                        //  3.4.2. 사업자 등록 요청 전송
                                        connection.query(upt_add_provider, err => {
                                            if (err) {
                                                logger.error(`[ AMQP:uptProviderErr ] ${err}`);
                                                connection.end();
                                            }
                                            // 전송 이력 DB 저장 후 메세지 송신
                                            logger.info(`[ AMQP:sendToqueue ] 메세지 송신 결과\n${JSON.stringify(addSrvcMsg, null, 4)}`);

                                            ch.sendToQueue("ERK_API_QUEUE", addSrvcMsg_buf);

                                            addSrvcMsg = null;
                                            addSrvcMsg_buf = null;
                                            upt_add_provider = null;
                                        });
                                    }
                                });
                            });

                            recvMsg = null;
                        }

                        break;
                    case 'DelServiceProviderInfoRP':
                        logger.info(`[ RMQ:DelServiceProviderInfoRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);

                        break;
                    case 'UpdServiceProviderInfoRP':
                        logger.info(`[ RMQ:UpdServiceProviderInfoRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                        
                        break;
                    //  사용자 관련 인터페이스
                    case 'AddUserInfoRP':
                        logger.info(`[ RMQ:AddUserInfoRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                        
                        if(recvMsg.AddUserInfoRP.ResultType === 1 || recvMsg.AddUserInfoRP.ResultType === 10) {
                            // userinfo_return_code = '${recvMsg.AddUserInfoRP.ResultType}',
                            let upt_addUsrrp_info = `UPDATE emo_user_info
                            SET userinfo_return_code = 1,
                                userinfo_userId = "${recvMsg.AddUserInfoRP.UserId}",
                                user_type = "${recvMsg.AddUserInfoRP.UserType}",
                                userinfo_serviceType = "${recvMsg.AddUserInfoRP.ServiceType}",
                                userinfo_recv_dt = NOW(3),
                                insert_dt = NOW(3),
                                update_dt = NOW(3),
                                del_yn = null
                            WHERE org_name = "${recvMsg.AddUserInfoRP.OrgName}"
                            AND login_id = "${recvMsg.AddUserInfoRP.UserName}";`;

                            connection.query(upt_addUsrrp_info, (err, result) => {
                                if (err) {
                                    logger.error(`[ RMQ:upt_addUsrrp_info ] ${err}`);
                                    connection.end();
                                }

                                logger.info(`[ RMQ:upt_addUsrrp_info_ok ] 사용자 정보 업데이트 성공\n${upt_addUsrrp_info}`);
                            });

                            recvMsg = null;
                        } else {
                            let upt_addUsrrp_info_nok = `UPDATE emo_user_info
                            SET org_name = "${recvMsg.AddUserInfoRP.OrgName}",
                                userinfo_return_code = "${recvMsg.AddUserInfoRP.ResultType}",
                                login_pw = "${recvMsg.AddUserInfoRP.UserPwd}",
                                org_id = "${recvMsg.AddUserInfoRP.OrgId}",
                                userinfo_recv_dt = NOW(3),
                                update_dt = NOW(3)
                            WHERE org_name = "${recvMsg.AddUserInfoRP.OrgName}"
                            AND user_name = "${recvMsg.AddUserInfoRP.UserName}";`;

                            // nok로 인해 userinfo_userId를 받지 못한 사용자 재등록 요청
                            recvMsg = null;
                        }

                        break;
                    case 'DelUserInfoRP':
                        logger.info(`[ RMQ:DelUserInfoRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);

                        //  ok 응답이면
                        if(recvMsg.DelUserInfoRP.ResultType === 1 || recvMsg.DelUserInfoRP.Return === 'Success') {
                            let deletingUserSubmit_query = `UPDATE emo_user_info
                            SET userinfo_userId = null, del_yn = 'Y'
                            WHERE user_name = '${recvMsg.DelUserInfoRP.UserName}';`;

                            connection.query(deletingUserSubmit_query, (err, results) => {
                                if(err) {
                                    logger.error(`[ app.js:deletingUserSubmit_query ] ${err}`);
                                    connection.end();
                                }
                                logger.info(`[ app.js:deletingUserSubmit_query ] 사용자 삭제 성공`)
                            });
                        } else {
                            logger.info(`[ RMQ:DelUserInfoRP ] 다른 응답코드 받음`);
                        }
                        
                        break;
                    case 'UpdUserInfoRP':
                        logger.info(`[ RMQ:UpdUserInfoRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                        
                        break;
                    //  ERK 서비스 연결관련 인터페이스
                    case 'ErkServiceConnRP':
                        logger.info(`[ RMQ:ErkServiceConnRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);

                        let upt_erkSrvcConn_ok = `UPDATE emo_user_info
                        SET erkserviceconn_recv_dt = NOW(3),
                        erkserviceconn_return_code = '1' 
                        WHERE userinfo_userId = ${recvMsg.ErkServiceConnRP.ErkMsgHead.UserId}
                        AND userinfo_serviceType = ${recvMsg.ErkServiceConnRP.ServiceType}`;

                        connection.query(upt_erkSrvcConn_ok, (err, result) => {
                            if (err) {
                                logger.error(`[ Consume:ErkServiceConnRP ] ${err}`);
                                connection.end();
                            }
                            logger.info(`[ Consume:ErkServiceConnRP ] ReturnCode ok 업데이트 성공\n${upt_erkSrvcConn_ok}`);
                        });

                        recvMsg = null;

                        break;
                    case 'ErkServiceDisConnRP':
                        logger.info(`[ Consume:ErkServiceDisConnRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                        
                        if (recvMsg.ErkServiceDisConnRP.ReturnCode === 1 || recvMsg.ErkServiceDisConnRP.ReturnCode === `ReturnCode_ok`) {
                            let upt_erkSrvcConn_ok = `UPDATE emo_user_info
                            SET erkservicedisconn_recv_dt = NOW(3), 
                            erkservicedisconn_return_code = '${recvMsg.ErkServiceDisConnRP.ReturnCode}'
                            WHERE userinfo_userId = ${recvMsg.ErkServiceDisConnRP.ErkMsgHead.UserId}`;

                            connection.query(upt_erkSrvcConn_ok, (err, result) => {
                                if (err) {
                                    logger.error(`[ Consume:ErkServiceDisConnRP ] ${err}`);
                                    connection.end();
                                }

                                logger.info(`[ Consume:ErkServiceDisConnRP ] 사용자 정보 업데이트 성공\n${upt_erkSrvcConn_ok}`);
                            });

                            recvMsg = null;
                        } else {
                            logger.info(`[ Consume:ErkServiceDisConnRP ] 일단 다른 응답 처리`);
                            logger.info(`[ Consume:ErkServiceDisConnRP ] recvMsg.ErkServiceDisConnRP.ReturnCode: ${recvMsg.ErkServiceDisConnRP.ReturnCode}`);
                            
                            //  그 외의 응답 결과 저장
                            let upt_erkSrvcConn_nok = `UPDATE emo_user_info SET erkservicedisconn_recv_dt = NOW(3),
                            erkservicedisconn_return_code = '1' WHERE userinfo_userId = ${recvMsg.ErkServiceDisConnRP.ErkMsgHead.UserId}`;

                            connection.query(upt_erkSrvcConn_nok, (err, results) => {
                                if (err) {
                                    logger.error(`[ Consume:ErkServiceDisConnRP ] ${err}`);
                                    connection.end();
                                }

                                logger.info(`[ Consume:ErkServiceDisConnRP ] DB 업데이트 완료\n${upt_erkSrvcConn_nok}`);
                            });

                            recvMsg = null;
                        }

                        break;
                    //  감성인지 Erk 엔진 관련 인터페이스
                    case 'EmoServiceStartRP':
                        logger.info(`[ Consume:ch2EmoServiceStartRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);

                        try {
                            if (recvMsg.EmoServiceStartRP.ReturnCode === 1 || recvMsg.EmoServiceStartRP.ReturnCode === `ReturnCode_ok`) {
                                receiveQueueName = recvMsg.EmoServiceStartRP.SpeechEngineInfo.ReceiveQueueName;
                                sendQueueName = recvMsg.EmoServiceStartRP.SpeechEngineInfo.SendQueueName;
    
                                //  데이터 저장(receiveQueueName가 ERK로 보내기 위해 사용하는 큐 네임)
                                let upt_engine_info = `UPDATE emo_user_info
                                SET erkEmoSrvcStartRP_returnCode = '${recvMsg.EmoServiceStartRP.ReturnCode}',
                                    erkengineInfo_return_engineType = '${recvMsg.EmoServiceStartRP.SpeechEngineInfo.EngineType}',
                                    erkengineInfo_return_condition = '${recvMsg.EmoServiceStartRP.SpeechEngineInfo.EngineCondition}',
                                    erkengineInfo_return_ipAddr = '${recvMsg.EmoServiceStartRP.SpeechEngineInfo.IpAddr}',
                                    erkengineInfo_returnCustomer_recvQueueName = '${receiveQueueName}',
                                    erkengineInfo_returnCustomer_sendQueueName = '${sendQueueName}',
                                    update_dt = NOW(3),
                                    erkEmoSrvcStart_recv_dt = NOW(3)
                                WHERE userinfo_userId = ${recvMsg.EmoServiceStartRP.ErkMsgHead.UserId};`;
    
                                connection.query(upt_engine_info, (err, results) => {
                                    if (err) {
                                        logger.error(`[ Consume:ch2EmoServiceStartRP ] ${err}`);
                                        throw err;
                                    }
                                    logger.info(`[ Consume:ch2EmoServiceStartRP ] ch2EmoServiceStartRP 수신 정보 업데이트 성공`);
                                });

                                //  Stream Queue 생성 함수 호출 (채널, EmoSrvcStartRP로 받은 ERK 큐, 현재 요청하는 세션 유저)
                                const getMyStreamQueueUser = recvMsg.EmoServiceStartRP.ErkMsgHead.UserId;
                                getMyStreamQueue(ch, receiveQueueName, getMyStreamQueueUser)
                                    .then(async (result) => {
                                        if (result.success) {
                                            logger.info(`[ app.js:getMyStreamQueue ] 스트림 큐 생성 성공`);

                                            //  전달받은 recvQueue 로 CH2 메세지 소비
                                            ch2.consume(`${sendQueueName}`, async (streamMsg) => {
                                                if(streamMsg !== null) {
                                                    //  응답 메세지의 content만 가져옴
                                                    let recvMsg = ErkApiMsg.decode(streamMsg.content);
                                                    
                                                    // recvMsg의 이름으로 분류
                                                    switch (Object.keys(recvMsg).toString()) {
                                                        //  감성 분석 인터페이스 response
                                                        case 'PhysioEmoRecogRP':
                                                            logger.info(`[ consume:PhysioEmoRecogRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                                                            break;
                                                        case 'SpeechEmoRecogRP':
                                                            logger.info(`[ consume:SpeechEmoRecogRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                                                            let SpeechEmoRecogTime_str = `${recvMsg.SpeechEmoRecogRP.EmoRecogTime}`;

                                                            if (recvMsg.SpeechEmoRecogRP.ReturnCode === 1 || recvMsg.SpeechEmoRecogRP.ReturnCode === `ReturnCode_ok`) {
                                                                try {
                                                                    // 정확도 표준화
                                                                    const accuracy = isNaN(recvMsg.SpeechEmoRecogRP.Accuracy) ? 0 : Number(recvMsg.SpeechEmoRecogRP.Accuracy);

                                                                    let SpeechEmoRecogRP_qry = `UPDATE emo_emotion_info
                                                                    SET speechEmo_returnCode = '${recvMsg.SpeechEmoRecogRP.ReturnCode}',
                                                                        EmoRecogTime = '${SpeechEmoRecogTime_str}',
                                                                        emotion_type = ${recvMsg.SpeechEmoRecogRP.Emotion},
                                                                        accuracy = ${accuracy},
                                                                        recv_dt = NOW(3)
                                                                    WHERE userinfo_userId = ${recvMsg.SpeechEmoRecogRP.ErkMsgDataHead.UserId}
                                                                    AND send_dt = '${DateUtils.getCurrentDateTimeString(SpeechEmoRecogTime_str)}';`;

                                                                    logger.warn(`[ consume:SpeechEmoRecogRP ] 정상 응답\n${SpeechEmoRecogRP_qry}`);

                                                                    connection.query(SpeechEmoRecogRP_qry, (err, results) => {
                                                                        if (err) {
                                                                            logger.error(`[ consume:SpeechEmoRecogRP_qry ] ${err}`);
                                                                            return err;
                                                                        }

                                                                        logger.info(`[ consume:SpeechEmoRecogRP_qry ] 업데이트 성공`);
                                                                    });
                                                                } catch (err) {
                                                                    logger.error(`[ consume:SpeechEmoRecogRP ] 데이터 처리 오류 ${err}`);
                                                                }
                                                            } else {
                                                                logger.error('[ consume:SpeechEmoRecogRP ] 다른 응답');

                                                                if (isNaN(recvMsg.SpeechEmoRecogRP.SpeechEngineInfo.Accuracy)) {
                                                                    recvMsg.SpeechEmoRecogRP.Accuracy = 0;
                                                                    recvMsg.SpeechEmoRecogRP.Emotion = 'EmotionType_unknown';
                                                                }

                                                                //  현재 전송중인 음원파일의 key는 datetime으로 매핑하여 구분
                                                                let SpeechEmoRecogRP_qry = `UPDATE emo_emotion_info
                                                                SET speechEmo_returnCode = '${recvMsg.SpeechEmoRecogRP.ReturnCode}',
                                                                    EmoRecogTime = '${recvMsg.SpeechEmoRecogRP.EmoRecogTime}',
                                                                    emotion_type = ${recvMsg.SpeechEmoRecogRP.Emotion},
                                                                    accuracy = ${Number(recvMsg.SpeechEmoRecogRP.Accuracy)},
                                                                    recv_dt = NOW(3)
                                                                WHERE userinfo_userId = ${recvMsg.SpeechEmoRecogRP.ErkMsgDataHead.UserId}
                                                                AND send_dt = '${DateUtils.getCurrentDateTimeString(recvMsg.SpeechEmoRecogRP.EmoRecogTime)}';`;

                                                                logger.warn(`[ consume:SpeechEmoRecogRP ] ${SpeechEmoRecogRP_qry}`);

                                                                connection.query(SpeechEmoRecogRP_qry, (err, results) => {
                                                                    if (err) {
                                                                        logger.error(`[ consume:SpeechEmoRecogRP_qry ] ${err}`);
                                                                        connection.end();
                                                                    }

                                                                    logger.info(`[ consume:SpeechEmoRecogRP_qry ] 업데이트 성공`);
                                                                });
                                                            }
                                                            
                                                            break;
                                                        case 'FaceEmoRecogRP':
                                                            logger.info(`[ consume:FaceEmoRecogRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                                                            break;
                                                        case 'EmoRecogRP':
                                                            logger.info(`[ consume:EmoRecogRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                                                            break;
                                                        //  기타
                                                        case 'ErkMsgType_reserved1':
                                                            logger.info(`[ consume:ErkMsgType_reserved1 ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                                                            break;
                                                        case 'ErkMsgType_reserved2':
                                                            logger.info(`[ consume:ErkMsgType_reserved2 ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);
                                                            break;
                                                        //  기본
                                                        default:
                                                            logger.warn(`[ consume:streamConsume ] 잘못된 메세지 형식 혹은 오류`);
                                                            return;
                                                    }

                                                    ch2.ack(streamMsg);
                                                }
                                            },{
                                                // [ noAck: true ]: queue에서 데이터를 가져간 다음, ack를 바로 반환하면서 바로 해당 queue에서 메세지 삭제 
                                                // ack를 받았을 경우만 큐에서 제거하기 위해 false로 설정
                                                noAck: false,
                                                arguments: {
                                                    'x-stream-offset': 'first'
                                                }
                                            });
                                        } else {
                                            logger.warn(`[ app.js:getMyStreamQueue ] 스트림 큐 생성 실패`);
                                            return null;
                                        }
                                    }).catch(err => {
                                        logger.error(`[ app.js:getMyStreamQueue ] ${err}`);
                                        return err;
                                    });
                            } else {
                                logger.info(`[ Consume:chEmoServiceStartRP ] recvMsg.EmoServiceStartRP.ReturnCode: ${recvMsg.EmoServiceStartRP.ReturnCode}`);
                                logger.info(`[ Consume:chEmoServiceStartRP ] recvMsg.EmoServiceStartRP.SpeechEngineInfo: ${recvMsg.EmoServiceStartRP.SpeechEngineInfo}`); // 값 안들어옴'

                                //  데이터 저장(receiveQueueName가 ERK로 보내기 위해 사용하는 큐 네임)
                                let upt_engine_info = `UPDATE emo_user_info
                                SET erkEmoSrvcStartRP_returnCode = '${recvMsg.EmoServiceStartRP.ReturnCode}',
                                    erkengineInfo_return_engineType = '${recvMsg.EmoServiceStartRP.SpeechEngineInfo.EngineType}',
                                    erkengineInfo_return_condition = '${recvMsg.EmoServiceStartRP.SpeechEngineInfo.EngineCondition}',
                                    erkengineInfo_return_ipAddr = '${recvMsg.EmoServiceStartRP.SpeechEngineInfo.IpAddr}',
                                    erkengineInfo_return_recvQueueName = '${receiveQueueName}',
                                    erkengineInfo_return_sendQueueName = '${sendQueueName}',
                                    update_dt = NOW(3),
                                    erkEmoSrvcStart_recv_dt = NOW(3)
                                WHERE userinfo_userId = ${recvMsg.EmoServiceStartRP.ErkMsgHead.UserId};`;

                                connection.query(upt_engine_info, (err, results) => {
                                    if (err) {
                                        logger.error(`[ Consume:ch2EmoServiceStartRP ] ${err}`);
                                        throw err;
                                    }
    
                                    logger.info(`[ Consume:ch2EmoServiceStartRP ] ${JSON.stringify(results, null, 4)}`);
                                });
    
                                return;
                            }
                        } catch(err) {
                            logger.error(`[ Consume:ch2EmoServiceStartRP ] Consume Error: ${err}`);
                            return;
                        }
                        
                        break;
                    case 'EmoServiceStopRP':
                        logger.info(`[ app.js:ch2EmoServiceStopRP ] 메세지 수신 결과\n${JSON.stringify(recvMsg, null, 4)}`);

                        try {
                            if (recvMsg.EmoServiceStopRP.ReturnCode === 1 || recvMsg.EmoServiceStopRP.ReturnCode === `ReturnCode_ok`) {                                
                                let EmoServiceStop_qry = `UPDATE emo_user_info
                                SET erkEmoSrvcStopRP_returnCode = '${recvMsg.EmoServiceStopRP.ReturnCode}',
                                    erkengineInfo_return_engineType = null,
                                    erkengineInfo_return_condition = null,
                                    erkengineInfo_return_ipAddr = null,
                                    erkengineInfo_return_recvQueueName = null,
                                    erkengineInfo_returnCustomer_recvQueueName = null,
                                    erkengineInfo_return_sendQueueName = null,
                                    erkengineInfo_returnCustomer_sendQueueName = null,
                                    update_dt = NOW(3),
                                    erkEmoSrvcStop_recv_dt = NOW(3)
                                WHERE userinfo_userId = ${recvMsg.EmoServiceStopRP.ErkMsgHead.UserId};`;

                                logger.info(`[ app.js:ch2EmoServiceStopRP ] ${EmoServiceStop_qry}`);

                                connection.query(EmoServiceStop_qry, (err, results) => {
                                    if (err) {
                                        logger.error(`[ app.js:ch2EmoServiceStopRP ] ${err}`);
                                        connection.end();
                                    }

                                    logger.info(`[ app.js:ch2EmoServiceStopRP ] 상태 업데이트 성공`);
                                });
                            } else {
                                logger.info(`[ app.js:ch2EmoServiceStopRP ] 다른 응답(정상)`);
                                
                                let EmoServiceStop_qry = `UPDATE emo_user_info
                                SET erkEmoSrvcStopRP_returnCode = '${recvMsg.EmoServiceStopRP.ReturnCode}',
                                    erkengineInfo_return_engineType = null,
                                    erkengineInfo_return_condition = null,
                                    erkengineInfo_return_ipAddr = null,
                                    erkengineInfo_return_recvQueueName = null,
                                    erkengineInfo_returnCustomer_recvQueueName = null,
                                    erkengineInfo_return_sendQueueName = null,
                                    erkengineInfo_returnCustomer_sendQueueName = null,
                                    update_dt = NOW(3),
                                    erkEmoSrvcStop_recv_dt = NOW(3)
                                WHERE userinfo_userId = ${recvMsg.EmoServiceStopRP.ErkMsgHead.UserId};`;

                                logger.info(`[ app.js:ch2EmoServiceStopRP ] ${EmoServiceStop_qry}`);

                                connection.query(EmoServiceStop_qry, (err, results) => {
                                    if (err) {
                                        logger.error(`[ app.js:ch2EmoServiceStopRP ] ${err}`);
                                        connection.end();
                                    }

                                    logger.info(`[ app.js:ch2EmoServiceStopRP ] 상태 업데이트 성공`);
                                });
                            }
                        } catch(err) {
                            logger.error(`[ app.js:ch2EmoServiceStopRP ] Error saving data ${err}`);
                        }

                        break;
                    //  기본
                    default:
                        logger.warn(`[ app.js:consumeDefault ] 잘못된 메세지 형식 혹은 오류`);
                        return;
                }

                ch2.ack(msg); // 수신 확인 기능, 메세지를 성공적으로 수신하고 처리했다는 정보를 송신자(ETRI)에게 알려줌
            }, {
                // [noAck: true]면 queue에서 데이터를 가져간 다음, ack를 바로 반환하면서 바로 해당 queue에서 메세지 삭제 
                // ack를 받았을 경우만 큐에서 제거하기 위해 false로 설정
                noAck: false
            });

            //  Stream Queue 선언 및 consume 구현 함수
            async function getMyStreamQueue(ch, recvQueue, sessionUser) {
                try {
                    logger.info(`[ app.js:getMyStreamQueue ] getMyStreamQueue 함수 호출 성공`);
                    logger.info(`[ app.js:getMyStreamQueue ] 해당 스트림큐 요청자 userId: ${sessionUser}`);

                    //  Stream Queue 선언
                    const queueOptions = {
                        durable: true,
                        exclusive : false,
                        arguments: {
                            'x-queue-type': 'stream'
                        }
                    };

                    //  큐 존재 여부 확인 및 생성
                    const queueInfo = ch.assertQueue(recvQueue, queueOptions);
                    if (queueInfo.messageCount > 0) {
                        logger.info(`[ AMQP:assertQueue ] 기존 Stream 큐 '${recvQueue}' 확인됨. 메시지 수: ${queueInfo.messageCount}`);
                    } else {
                        logger.info(`[ AMQP:assertQueue ] 새로운 Stream 큐 '${recvQueue}' 확인 및 생성 완료`);
                    }

                    return { success: true, sessionUser: sessionUser };
                } catch(err) {
                    logger.error(`[ app.js:createStreamQueue ] ${err}`);
                    return { success: false, error: err.message };
                }
            }

            //  녹취 디렉토리 모니터링
            async function watchDirectory() {
                //  1. 파일 감시 시작
                const fsWatcher = new EnhancedFSWatcher({ pollingInterval: 100 });

                try {
                    //  2. NFS 마운트 상태 확인
                    if (!fs.existsSync(DIRECTORIES.NFS_MOUNT) || !fs.readdirSync(DIRECTORIES.NFS_MOUNT)) {
                        throw new Error('[ app.js:startApplication ] NFS 마운트 포인트에 접근할 수 없습니다.');
                    }
                    logger.info('[ app.js:startApplication ] NFS 마운트 체크를 성공했습니다.');

                    // 3. Watcher 초기화 및 이벤트 핸들러 설정
                    const watcher = await fsWatcher.initializeWatcher();

                    // 4. 메트릭 모니터링 설정
                    // const metricsInterval = setInterval(() => {
                    //     const metrics = fsWatcher.metrics;
                    //     const avgDelay = fsWatcher.calculateAverageDelay();
                    //     const successRate = metrics.successfulEvents / (metrics.successfulEvents + metrics.missedEvents) || 0;
            
                    //     logger.info(`[ app.js:watchDirectory ] File System Metrics:
                    //     Average Delay: ${avgDelay.toFixed(2)}ms
                    //     Success Rate: ${(successRate * 100).toFixed(2)}% 
                    //     Current Polling Interval: ${fsWatcher.config.pollingInterval}ms
                    //     Total Events: ${metrics.successfulEvents + metrics.missedEvents}`);
                    // }, 60000);

                    // 4. 프로세스 처리
                    const cleanup = async () => { fsWatcher.cleanup(); };

                     // 5. 종료 처리
                    process.on('SIGINT', async () => {
                        logger.info('[ watchDirectory:processSIGINT ] Received SIGINT. Cleaning up...');
                        await cleanup();
                        
                        logger.info('[ watchDirectory:processSIGINT ] File watcher closed');
                        process.exit(0);
                    });
            
                    process.on('uncaughtException', async (error) => {
                        logger.error('[ watchDirectory:processUncaughtException ] Uncaught Exception:', error);
                        await cleanup();

                        logger.info('[ watchDirectory:processUncaughtException ] File watcher closed due to error');
                        process.exit(1);
                    });

                    // 6. 종료 처리를 위한 promise 반환
                    return new Promise((resolve, reject) => {
                        if (!watcher) {
                            reject(new Error('[ app.js:watchDirectory ] Failed to initialize watcher'));
                            return;
                        }
            
                        watcher.on('error', async (error) => {
                            logger.error('[ app.js:watchDirectory ] Critical watcher error:', error);
                            await cleanup();

                            reject(error);
                        });
            
                        logger.info('[ app.js:watchDirectory ] File watcher successfully started');
                        resolve(watcher);
                    });
                } catch (error) {
                    logger.error(`[ app.js:watchDirectory ] Failed to start application: ${error}`);
                    throw error;
                }
            }

            //  241216 단위테스트 3.3
            async function sendAudioChunksT(filePath, userId) {
                try {
                    logger.info(`[ app.js:sendAudioChunksT ] 전달받은 사용자 정보: ${JSON.stringify(userId, null, 4)}`);
                    logger.info(`[ app.js:sendAudioChunksT ] 전달받은 filePath: ${filePath}`);

                    //  WAV 파일 헤더 SEARCH
                    const { result: headerLength, filePath: checkedFilePath } = await findWavHeaderLengthT(filePath);

                    //  전처리 된 WAV 파일 읽기
                    const data = await fsp.readFile(checkedFilePath);

                    //  오디오 파일 로깅 디렉토리 설정
                    const logDir = path.join(__dirname, 'logs/audio_log');
                    if (!fs.existsSync(logDir)) {
                        logger.warn(`[ app.js:makingLogDir] audio_log 폴더가 없어 생성합니다.`);
                        fs.mkdirSync(logDir);
                    }

                    //  오디오 데이터 송신시 기준
                    const SAMPLE_RATE = 16000; // 16kHz
                    const BYTES_PER_SAMPLE = 2; // 16비트(2바이트) 샘플
                    const CHUNK_DURATION = 1; // 1초 단위로 청크 분할
                    const TOTAL_CHUNK_SIZE = 44000; // MsgDataFrame의 고정 크기
                    const RAW_CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_DURATION; // 32000 바이트

                    const fileInfo_callId = path.basename(checkedFilePath, '.wav');    // 확장자 명을 제외한 파일명을 반환
                    const file_audio = data.slice(headerLength);    // 헤더 제거 후 file_audio
            
                    // 분할 횟수 산정
                    let fullData = new Int16Array(file_audio.buffer, file_audio.byteOffset, file_audio.byteLength / BYTES_PER_SAMPLE);
                    const numberOfChunks = Math.ceil(fullData.length / (RAW_CHUNK_SIZE / BYTES_PER_SAMPLE));
            
                    logger.info(`FILEPATH : ${checkedFilePath}, FILEHEADER 크기: ${headerLength}, numberOfChunks: ${numberOfChunks}`);
                    logger.info(`FILENAME : ${fileInfo_callId}, 원본 FILEDATA 크기: ${data.byteLength}, 자른 후 FILEDATA 크기: ${file_audio.byteLength}`);

                    //    - ErkDataHeader 선언 및 SpeechEmoRecogRQ 선언
                    //   3.1. Erk 큐 정보
                    const QueueInfoQuery = `SELECT * FROM emo_user_info eui 
                    INNER JOIN emo_provider_info epi ON eui.org_name = epi.org_name 
                    WHERE eui.login_id = ? OR eui.userinfo_userId = ?;`;
        
                    const results = await new Promise((resolve, reject) => {
                        connection.query(QueueInfoQuery, [userId.login_id, userId.userinfo_userId+10], (err, results) => {
                            if (err) {
                                logger.error(`[ sendAudioChunks:QueueInfoQuery ] ${err}`);
                                reject(err);
                            }
                            logger.warn(JSON.stringify(results, null, 4));

                            resolve(results);
                        });
                    });

                    if (!results.length || !results[0].erkengineInfo_return_sendQueueName || !results[0].erkengineInfo_return_recvQueueName) {
                        throw new Error('[ app.js:sendAudioChunks ] 할당받은 스트림 큐 없음');
                    }

                    const { 
                        erkengineInfo_return_sendQueueName,
                        erkengineInfo_return_recvQueueName,
                        org_id,
                        userinfo_userId
                    } = results[0];

                    const erkengineInfo_returnCustomer_recvQueueName = String(results[1].erkengineInfo_returnCustomer_recvQueueName) || '';;
                    const erkengineInfo_returnCustomer_sendQueueName = String(results[1].erkengineInfo_returnCustomer_sendQueueName) || '';;

                    logger.info(`[ app.js:sendAudioChunks ] 상담원 수신(ERK 엔진이 받는) 스트림 큐: ${erkengineInfo_return_recvQueueName}`);
                    logger.info(`[ app.js:sendAudioChunks ] 상담원 송신(NB로 보내는) 스트림 큐: ${erkengineInfo_return_sendQueueName}`);

                    logger.info(`[ app.js:sendAudioChunks ] 고객 수신(ERK 엔진이 받는) 스트림 큐: ${erkengineInfo_returnCustomer_recvQueueName}`);
                    logger.info(`[ app.js:sendAudioChunks ] 고객 송신(NB로 보내는) 스트림 큐: ${erkengineInfo_returnCustomer_sendQueueName}`);

                    const ErkQueueInfo = ErkApiMsg.create({
                        ToQueueName: `${erkengineInfo_return_recvQueueName}`,
                        FromQueueName: `${erkengineInfo_return_sendQueueName}`
                    });

                    const ErkQueueInfo_cus = ErkApiMsg.create({
                        ToQueueName: "RECV_02_012_012",
                        FromQueueName: "SEND_02_012_012"
                    });

                    const ErkMsgDataHeader = ErkApiMsg.create({
                        MsgType: 27, // SpeechEmoRecogRQ
                        TransactionId: sessionUser.userinfo_uuid,
                        QueueInfo: ErkQueueInfo,
                        OrgId: org_id,
                        UserId: userinfo_userId
                    });

                    const ErkMsgDataHeader_cus = ErkApiMsg.create({
                        MsgType: 27, // SpeechEmoRecogRQ
                        TransactionId: sessionUser.cusinfo_uuid,
                        QueueInfo: ErkQueueInfo_cus,
                        OrgId: org_id,
                        UserId: userinfo_userId+10
                    });

                    //  청크 전송
                    const sendChunk = async (i) => {
                        const start = i * (RAW_CHUNK_SIZE / BYTES_PER_SAMPLE);
                        const end = Math.min(start + (RAW_CHUNK_SIZE / BYTES_PER_SAMPLE), fullData.length);
                        let chunk = fullData.slice(start, end);

                        // 1. 22000 샘플 크기의 Uint16Array 생성 (44000 바이트에 해당)
                        let paddedChunk = new Uint16Array(TOTAL_CHUNK_SIZE / BYTES_PER_SAMPLE);

                        // 2. 실제 오디오 데이터 복사 (최대 16000 샘플)
                        const samplesToCopy = Math.min(chunk.length, RAW_CHUNK_SIZE / BYTES_PER_SAMPLE);
                        paddedChunk.set(chunk.subarray(0, samplesToCopy));

                        // 3. Uint16Array를 Uint8Array로 변환 (바이트 표현을 위해)
                        let byteArray = new Uint8Array(paddedChunk.buffer);

                        //  3. 메세지 생성
                        const currentTimestamp = DateUtils.getCurrentTimestamp();
                        const currentDateTimeString = DateUtils.getCurrentDateTimeString(currentTimestamp);

                        const sendSpeechMsg = ErkApiMsg.create({
                            SpeechEmoRecogRQ: {
                                ErkMsgDataHead: ErkMsgDataHeader,
                                DataTimeStamp: currentTimestamp,
                                MsgDataLength: samplesToCopy * BYTES_PER_SAMPLE,
                                MsgDataFrame: [byteArray]
                            }
                        });

                        const sendSpeechMsg_cus = ErkApiMsg.create({
                            SpeechEmoRecogRQ: {
                                ErkMsgDataHead: ErkMsgDataHeader_cus,
                                DataTimeStamp: currentTimestamp,
                                MsgDataLength: samplesToCopy * BYTES_PER_SAMPLE,
                                MsgDataFrame: [byteArray]
                            }
                        });

                        logger.warn(`[ app.js:sendChunk ] 메세지 송신결과\n${JSON.stringify(sendSpeechMsg, (key, value) => {
                            if (key === 'MsgDataFrame') { return `[ Uint8Array of length ${value.length} ]`; }
                            return value;
                        }, 4)}`);

                        logger.warn(`[ app.js:sendChunk ] 메세지 송신결과\n${JSON.stringify(sendSpeechMsg_cus, (key, value) => {
                            if (key === 'MsgDataFrame') { return `[ Uint8Array of length ${value.length} ]`; }
                            return value;
                        }, 4)}`);

                        const SpeechEmoRecogRQ_save_qry = `INSERT INTO emo_emotion_info (login_id, file_name, file_seq, sendQueueName, recvQueueName, org_id, userinfo_userId, send_dt, data_length)
                        VALUES ('${results[0].login_id}', '${fileInfo_callId}', '${i+1}', '${results[0].erkengineInfo_return_sendQueueName}', '${results[0].erkengineInfo_return_recvQueueName}', '${results[0].org_id}'
                        , ${results[0].userinfo_userId}, '${currentDateTimeString}', ${(chunk.length) * 2});`;

                        try {
                            // DB 쿼리 실행
                            await new Promise((resolve, reject) => {
                                logger.warn(`[ app.js:SpeechEmoRecogRQ_save_qry ] ${SpeechEmoRecogRQ_save_qry}`);
                                connection.query(SpeechEmoRecogRQ_save_qry, (err, result) => {
                                    if (err) {
                                        logger.error(`[ app.js:SpeechEmoRecogRQ_save_qry ] ${err}`);
                                        reject(err);
                                    } else {
                                        logger.info(`[ app.js:SpeechEmoRecogRQ_save_qry ] SpeechEmoRecogRQ_save_qry 성공`);
                                        resolve(result);
                                    }
                                });
                            });

                            //  메세지 인코딩
                            let sendSpeechMsg_buf = ErkApiMsg.encode(sendSpeechMsg).finish();
                            let sendSpeechMsg_buf_cus = ErkApiMsg.encode(sendSpeechMsg_cus).finish();

                            await ch.sendToQueue(`${results[0].erkengineInfo_return_recvQueueName}`, sendSpeechMsg_buf, { persistent: true });
                            await ch2.sendToQueue("RECV_02_012_012", sendSpeechMsg_buf_cus, { persistent: true });

                            // 송신 후 로깅
                            logger.warn(`[ app.js:sendChunk ] Chunk sent. Size: ${paddedChunk.length} bytes, First few bytes: ${Array.from(paddedChunk.slice(0, 10))}`);
                            logger.warn(`[ app.js:sendChunk ] Chunk ${i+1}/${numberOfChunks} sent. Start: ${start}, End: ${end}, Size: ${chunk.length} bytes. 메세지 송신 성공.`);

                            //   - 로깅1) 각 청크를 파일로 저장
                            const chunkFileName = path.join(logDir, `chunk_${i+1}_${DateUtils.getCurrentTimestamp()}.pcm`);
                            fs.writeFileSync(chunkFileName, Buffer.from(paddedChunk.buffer, 0, samplesToCopy * BYTES_PER_SAMPLE));

                            //   - 로깅2) Array를 파일로 저장
                            const ArrayFileName = path.join(logDir, `chunk_${i+1}_${DateUtils.getCurrentTimestamp()}.txt`);
                            const ArrayString = Array.from(paddedChunk).join('  ');
                            fs.writeFileSync(ArrayFileName, ArrayString);                            

                            //   - 로깅3) 메타데이터 및 전송 정보
                            const logMessage = `[ app.js:sendChunk ] Chunk ${i+1} logged at ${DateUtils.getCurrentTimestamp()}\n` +
                            `Original length: ${samplesToCopy * BYTES_PER_SAMPLE} bytes\n` +    // 원본 오디오 데이터 크기
                            `Padded length: ${paddedChunk.length * BYTES_PER_SAMPLE} bytes\n` +    // 패딩을 포함한 전체 청크 크기
                            `Actual data sent: ${samplesToCopy * BYTES_PER_SAMPLE} bytes\n` +    // 실제 전송된 데이터 크기
                            `Non-zero bytes: ${paddedChunk.filter(b => b !== 0).length} bytes\n` +  // 실제 전송된 데이터 크기 중 0이 아닌 바이트의 수(낮은 볼륨 or 무음 등...)
                            `Saved to: ${chunkFileName}\n`;

                            //   - 로깅4) 메세지 전송 이력
                            fs.appendFileSync(path.join(logDir, 'transmission_log.txt'), logMessage);
                            logger.info(`[ app.js:sendChunk ] Chunk ${i+1} sent and logged`);
                        } catch(err) {
                            logger.error(`[ app.js:SpeechEmoRecogRQ ] Error sending chunk ${i+1}: ${err}`);
                        }
                    };

                    //  분할 횟수만큼 전송
                    let successCount = 0;
                    for (let i=0; i<numberOfChunks; i++) {
                        try {
                            await sendChunk(i);  // 각 청크 전송이 완료될 때까지 기다림
                            successCount++;
                            logger.warn(`[ app.js:sendChunk ] Chunk ${i+1} sent successfully`);
                        } catch (error) {
                            logger.error(`[ app.js:sendChunk ] Error sending chunk ${i+1}:`, error);
                            // 오류 발생 시 재시도 로직
                            await new Promise(resolve => setTimeout(resolve, 1000)); // 1초 대기 후 재시도
                            i--; // 현재 청크 재시도
                    
                            continue;
                        }
                    
                        // 다음 청크 전송 전에 짧은 지연 발생시킴
                        // await new Promise(resolve => setTimeout(resolve, 1000));
                    }

                    if (successCount === numberOfChunks) {
                        return { success: true, message: 'All chunks sent successfully' };
                    } else {
                        return { success: false, message: `Only ${successCount} out of ${numberOfChunks} chunks sent successfully` };
                    }
                } catch(err) {
                    logger.error(`[ app.js:sendAudioChunks ] sendAudioChunks 함수에서 오류 발생: ${err}`);
                    return { success: false, message: err.message };
                }
            }

            //  WAV 파일 헤더 길이 파악
            async function findWavHeaderLengthT(filePath) {
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
        })
        .catch(err => {
            logger.error(`[ app.js:loadProto ] ${err}`);
            return;
        }); // loadProto() End
}); // amqp.connect() End

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

//  WebSocket 연결
io.on('connection', (socket) => {
    loginIDs++;
    const sessionUserId = socket.handshake.session.user;

    //  클라이언트 IP 추적
    let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    
    if (socket.handshake.headers['x-forwarded-for']) {
        // X-Forwarded-For 헤더가 있으면 첫 번째 IP를 사용
        clientIp = forwardedFor.split(',')[0].trim();
    }

    if (sessionUserId && sessionUserId.login_id) {
        // 소켓 객체에 상담사 이름, id, 권한 정보 추가
        socket.agentName  = sessionUserId.user_name;
        socket.agent_id   = sessionUserId.login_id;
        socket.user_id = sessionUserId.userinfo_userId;
        socket.userType   = sessionUserId.group_manager;

        // 연결 시
        loginIDsArr.set(socket.agent_id, {
            socket: socket.id,
            user: socket.agentName,
            id: socket.agent_id,
            uid: socket.user_id,
            type: socket.userType
        });

        //  특정 소켓(room)을 통해 데이터 전송
        const room = sessionUserId.login_id;
        socket.join(room);

        //   - io.sockets.emit: 모든 클라이언트에게 전송
        //   - socket.broadcast.emit: 새로 생성된 연결을 제외한 다른 클라이언트에게 전송
        //   - socket.join : 사용자를 특정 방에 참여
        //  관리자면 메세지 전송 X
        if (socket.userType === 'Y') {
            logger.info(`[ app.js:socketConnected ] 상담관리자: ${room} 접속[${clientIp}]`);
            logger.info(`[ app.js:socketConnected ] 접속일시: ${DateUtils.getCurrentDate()}`);

            io.to(room).emit('server_msg', `상담관리자${room} 접속[${clientIp}]`);
            io.to(room).emit('server_msg', `접속일시: ${DateUtils.getCurrentDate()}`);
        } else {
            // 상담원이면 클라이언트 메세지창에 전송
            logger.info(`[ app.js:socketConnected ] 상담원: ${room} 접속[${clientIp}]`);
            logger.info(`[ app.js:socketConnected ] 접속일시: ${DateUtils.getCurrentDate()}`);

            io.to(room).emit('server_msg', `상담원${room} 접속[${clientIp}]`);
            io.to(room).emit('server_msg', `접속일시: ${DateUtils.getCurrentDate()}`);
        }

        //  사용자 접속 상태 확인
        logger.info(`[ app.js:socketConnected ] 현재 연결된 사용자: ${loginIDsArr.size}명`);
        logger.info(`[ app.js:socketConnected ] 현재 연결된 사용자 ID: ${[...loginIDsArr.entries()]}`);
    }

    //  웹소켓 연결 해제 시
    socket.on('disconnect', async (reason) => {
        try {
            if (gsmStream) {
                gsmStream.end();
            }
            clearInterval(copyInterval);

            let disconnectedUser = null;
            let disconnectedKey = null;

            // Map을 순회하며 해당 socket.id를 가진 사용자를 찾습니다.
            for (let [key, value] of loginIDsArr) {
                if (value.socket === socket.id) {
                    disconnectedUser = value;
                    disconnectedKey = key;

                    break;
                }
            }

            if (disconnectedUser) {
                // 찾은 사용자를 Map에서 삭제합니다.
                loginIDsArr.delete(disconnectedKey);
    
                logger.info(`[ app.js:socketDisConnected ] ${reason}`);
                logger.info(`[ app.js:socketDisConnected ] 클라이언트 연결해제 [IP: ${clientIp}, 사용자: ${disconnectedUser.user}]`);
                logger.info(`[ app.js:socketDisConnected ] 현재 연결된 사용자: ${loginIDsArr.size}명`);
    
                // loginIDs 변수가 여전히 필요하다면 여기서 감소시킵니다.
                loginIDs--;
            } else {
                logger.info(`[ app.js:socketDisConnected ] 연결 해제된 사용자를 찾을 수 없습니다. Socket ID: ${socket.id}`);
            }
        } catch(exception) {
            logger.error(`[ app.js:socketDisConnected ] ${exception}`);
        }
    });

    //  웹소켓 오류 발생 시
    socket.on('error', (err) => {
        logger.error(`[ app.js:socketError ] ${err}`);
        return false;
    });

    //  클라이언트로부터 메세지 수신 시
    socket.on('message', (message) => { logger.info(`[ app.js:socketOnMessage ] 클라이언트 정상 응답 '${message}'`); });

    //  WebSocket 서버 → 클라이언트 상담원 정보 전송
    socket.on('client_name', (data) => {
        logger.info(`[ app.js:socketClientName ] 서버에서 보낸 상담원 이름 → ${data}`);

        global_passive_info.push(data);
        logger.info(`[ app.js:socketClientName ] 전역변수 배열에 상담사 정보 저장 → ${global_passive_info}`);
    });
}); // WebSocket.connection() End

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

cron.schedule('*/5 * * * * *', () => { callProcedure(); });  // 자동코칭 조회

//  [자동 코칭 관련]
// 1. 5초마다 selectAutoCoach 함수 실행
function callProcedure() {
    try {
        // 3초 기준으로 분석된 감성파일을 10, 30, 60초 구간을 기준으로 코칭 발생 조건 조회하는 프로시저 호출
        let auto_coach_procedure_10 = `CALL emoCoachingMessage10_Proc('${DateUtils.getYearMonthDay()}');`;
        let auto_coach_procedure_30 = `CALL emoCoachingMessage30_Proc('${DateUtils.getYearMonthDay()}');`;
        let auto_coach_procedure_60 = `CALL emoCoachingMessage60_Proc('${DateUtils.getYearMonthDay()}');`;

        connection.query(auto_coach_procedure_10 + auto_coach_procedure_30 + auto_coach_procedure_60, (err, results) => {
            if (err) {
                logger.error(`[ app.js:callProcedure ] ${err}`);
                return ;
            }
    
            // 프로시저 호출 후 자동 검색 조건 검색
            if (results[0].affectedRows != 0 || results[1].affectedRows != 0 || results[2].affectedRows != 0) {
                logger.info(`[ app.js:callProcedure ] 'emoCoachingMessage10_Proc' 프로시저 호출 결과: ${results[0].affectedRows}개`);
                logger.info(`[ app.js:callProcedure ] 'emoCoachingMessage30_Proc' 프로시저 호출 결과: ${results[1].affectedRows}개`);
                logger.info(`[ app.js:callProcedure ] 'emoCoachingMessage60_Proc' 프로시저 호출 결과: ${results[2].affectedRows}개`);
    
                selectAutoCoach(DateUtils.getYearMonthDay());
            }
        });
    } catch(err) {
        logger.error(`[ app.js:callProcedure ] ${err}`);
        throw err;
    }
}

//  2. 자동코칭이 필요한 데이터를 조회 및 메세지 전송
//   - 코칭등록 번호, 통화날짜, 통화시간, 상담원 ID가 필요
//   - 접속한 상담원 및 관리자 여부와 상관없이 시스템에서는 계속 체크
function selectAutoCoach(callDate) {
    try {
        //  금일 자동코칭이 필요한 상담원 조회
        let searchAuto_query = `SELECT * FROM emo_coaching_message WHERE auto_coach = 'A' AND send_yn = 'N' AND call_date = '${callDate}';`;
        connection.query(searchAuto_query, (err, results) => {
            if (err) {
                logger.error(`[ app.js:selectAutoCoach ] ${err}`);
                throw err;
            }
    
            if (results.length === 0) { return logger.info('[ app.js:selectAutoCoach ] 자동 코칭 조건이 조회되지 않음'); }
            logger.info(`[ app.js:selectAutoCoach ] 자동 코칭 조건 결과 및 개수 : ${results.length}개`);

            if (loginIDsArr.size === 0) { return logger.info('[ app.js:selectAutoCoach ] 현재 접속중인 사용자 없음'); }
    
            //  i) 자동코칭이 필요한 상담원 갯수 체크
            // 세션의 배열 반복 조회 (접속중인 사용자)
            for (const [key, agent] of loginIDsArr) {
                // 자동 코칭 예약 조건과 같은 세션 ID 및 관리자 여부 확인
                const matchingResult = results.find(r => r.login_id === agent.id && agent.group_manager !== 'Y');
                if (matchingResult) {
                    logger.info(`[ app.js:selectAutoCoach ] matchingResult\n${matchingResult}`);

                    const autoMoment = moment(matchingResult.call_date);

                    io.to(matchingResult.login_id).emit('auto_msg', `──────────────── [시스템 메세지] ────────────────\n`+
                    `※ 이 메세지는 시스템에서 자동 발송되는 메세지입니다.\n`+
                    `[메세지 발생시간] : ${matchingResult.insert_dt}\n`+
                    `[기준시간 및 날짜] : ${matchingResult.call_time}구간(시분초), ${autoMoment.format('YYYY년 MM월 DD일')}\n`+
                    `[상담원 ID] : ${matchingResult.login_id}\n`+
                    `[감성(화남) 초과 횟수] : ${matchingResult.agent_anger}회\n`+
                    `[감성(슬픔) 초과 횟수] : ${matchingResult.agent_sad}회\n`+
                    `[메세지 내용] : ${matchingResult.auto_detail}\n`+
                    "────────────────────────────────────────");

                    let updateAuto_query = `UPDATE emo_coaching_message
                    SET send_yn = 'Y', send_dt = NOW(3)
                    WHERE call_time = '${matchingResult.call_time}'
                    AND login_id = '${matchingResult.login_id}'
                    AND auto_seq = ${matchingResult.auto_seq}
                    AND auto_standard = ${matchingResult.auto_standard};`;

                    //  3. 자동코칭 후 테이블 업데이트
                    connection.query(updateAuto_query, (err) => {
                        if (err) {
                            logger.error(`[ app.js:updateAuto_query ] ${err}`);
                            throw err;
                        }

                        logger.info(`[ app.js:updateAuto_query ] updateAuto_query 쿼리 결과\n${updateAuto_query}`);
                        logger.info(`[ app.js:selectAutoCoach ] 자동 코칭 후 DB 업데이트 성공`);
                    });
                }
            }
        });
    } catch(err) {
        logger.error(`[ app.js:selectAutoCoach ] ${err}`);
    }
}