'use strict'

const DateUtils = require('../../utils/dateUtils');

const WebSocket = require(`ws`);
const loginIDs = new Array();
let global_passive_info = new Array();

module.exports = server => {
    // express 서버와 websocket 서버를 연결시킨다.
    // 변수 이름은 socket(web socket server)
    const wss = new WebSocket.Server({ server });

    wss.on(`connection`, (ws, req) => {
        // 소켓 연결 에러
        ws.on('error', (error) => {
            logger.error(`[ socket.js ] ${error}`);
            return false;
        });

        // ip 파악
        let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        ip = ip.replace('::ffff:', 'IPv6 ');
        console.log(`새로운 클라이언트 접속 ip : ${ip}`);

        // 소켓 객체에 상담사 이름, id, 권한 정보 추가
        socket.agentName = sendUserName;
        socket.agent_id = sendUserID;
        socket.userType = userType;

        if (socket.userType) {
            loginIDs.push({
                socket: socket.id,
                user: socket.agentName,
                id: socket.agent_id,
                type: socket.userType,
            });
        }

        if (userType == 2) {
            logger.info(`[ socket.io ] 상담관리자${sendUserID} 접속[${ip}]`);
            logger.info(`[ socket.io ] 접속일시: ${DateUtils.getCurrentDate()}`);
        } else {
            logger.info(`[ socket.io ] 상담사${sendUserID} 접속[${ip}]`);
            logger.info(`[ socket.io ] 접속일시: ${DateUtils.getCurrentDate()}`);

            // 특정 소켓을 통해 데이터 전송
            // io.sockets.emit: 모든 클라이언트에게 전송
            // socket.broadcast.emit: 새로 생성된 연결을 제외한 다른 클라이언트에게 전송
            socket.emit('server_msg', `상담사${sendUserID} 접속[${ip}]`);
            socket.emit('server_msg', `접속일시: ${DateUtils.getCurrentDate()}`);
        }

        // 새로고침시 loginIDs 배열에서 중복되는 항목을 제거
        for (let num in loginIDs) {
            if (loginIDs[num]['user'] === socket.agentName && loginIDs[num]['socket'] != socket.id) {
                loginIDs.splice(num, 1);
            }
        }
        logger.info(`[app.js] 현재 loginIDs: ${JSON.stringify(loginIDs)}`);

        /////////////////////////////////// 시스템 자동 코칭 ///////////////////////////////////
        cron.schedule('*/3 * * * * *', () => {
            logger.info(`[ socket.io ] 3초 스케줄 프로시저 호출`);
            return callProcedure();
        });

        /////////////////////////////////// 상담사 수동 메세지 전송 ///////////////////////////////////
        app.get('/manage/coaching_submit', function (req, res) {
        if (!req.session)
            return res.render('manage/login');

            // 코칭 메세지, 특이사항, 코칭 기준시간
            let coach_msg = req.query.passive_msg_detail;
            let coach_etc = req.query.passCounsel_etc;
            let coach_standard = global_passive_info[1].substring(global_passive_info[1].length - 2);

            // 시간, 날짜 전처리
            global_passive_info[0] = global_passive_info[0].substring(0, 4) + global_passive_info[0].substring(6, 8) + global_passive_info[0].substring(10, 12);
            global_passive_info[1] = global_passive_info[1].substring(0, 2) + global_passive_info[1].substring(3, 5) + global_passive_info[1].substring(6, 8);

            logger.info(`[ coaching_submit ] 수동 코칭 메세지 내용  : ** ${coach_msg} **`);
            logger.info(`[ coaching_submit ] 전달 할 상담사 날짜    : ** ${global_passive_info[0]} **`);
            logger.info(`[ coaching_submit ] 전달 할 상담사 시간    : ** ${global_passive_info[1]} **`);
            logger.info(`[ coaching_submit ] 전달 할 상담사 이름    : ** ${global_passive_info[2]} **`);
            logger.info(`[ coaching_submit ] 기준 시간              : ** ${coach_standard} **`);

            // socket 정보를 매핑하여 특정 클라이언트에게 전송  
            for (let num in loginIDs) {
                if (loginIDs[num]['user'] == global_passive_info[2].toString()) {
                    logger.info('[ coaching_submit ] 해당 상담사 접속중');
                    logger.info(`[ coaching_submit ] 보낼 소켓 ID : ${loginIDs[num]['socket']}`);

                    // 소켓을 통해 메세지 전송
                    io.to(loginIDs[num]['socket']).emit('admin_msg', ` ──────────────── [관리자 메세지] ────────────────
                    ** ${loginIDs[num]['user']}님! 관리자로부터 메세지가 도착했습니다. **
                    →→ "${coach_msg}"
                    ────────────────────────────────────────`);

                    let upt_pass_query = `UPDATE emo_coaching_message
                        SET send_yn = 'Y', pass_etc = '${coach_etc}'
                        WHERE agent_id = ${loginIDs[num]['id']}
                        AND STR_TO_DATE('${global_passive_info[0]}', '%Y%m%d')
                        AND call_time = '${global_passive_info[1]}'
                        AND auto_standard = 30
                        AND auto_coach = 'P';`;

                    connection.query(upt_pass_query, (err, result) => {
                        if (err) {
                            logger.error(`[ coaching_submit ] ${err}`);
                            connection.end();
                        }

                        logger.info(`[ coaching_submit ] 상담 코칭, 특이 사항 쿼리\n${upt_pass_query}`);
                        logger.info(`[ coaching_submit ] 쿼리 결과 : ${JSON.stringify(result)}`);
                    });

                    global_passive_info = new Array();
                    // 성공 res.send는 string, object, array 등을 보낼 수 있다. int형은 안됌
                    return res.status(200).json({
                        message: "SUCCESS"
                    });
                } else {
                    logger.info('[ coaching_submit ] 접속중인 상담사가 아닙니다.');
                    
                    global_passive_info = new Array();
                    return res.status(200).json({
                        message: "FAILED"
                    });
                }
            }
        });

        // 소켓 연결 해제
        ws.on('disconnect', (reason) => {
            try {
                for (let num in loginIDs) {
                    if (loginIDs[num]['user'] === socket.agentName && loginIDs[num]['socket'] === socket.id) {
                        loginIDs.splice(num, 1);
                    }
                }
            } catch (exception) {
                logger.info(`[ soket.io ] ${exception}`);
            } finally {
                logger.info(`[ socket.io ] 연결 해제 이유: ${reason}`);
                logger.info(`[ socket.io ] 연결 종료 - 클라이언트IP: ${ip}, 상담사: ${socket.agentName}`);
            }
        })

        // 코칭 전 해당 상담사 이름 전달
        ws.on('client_name', (data) => {
            logger.info(`[상담관리자가 보낸 상담사 이름]: ${data}`);

            global_passive_info.push(data);
            logger.info(`[전역변수 배열에 상담사 정보 저장] >>> ${global_passive_info}`);
        });
    });
}