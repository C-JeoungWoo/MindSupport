'use strict'

//  필요 라이브러리 호출
const { worker } = require(`worker_threads`);
const path = require(`path`);

//  WorkerPool 클래스 생성
class WorkerPool {
    //  구조체 생성
    constructor(numThreads, workerPath) {
        this.numThreads = numThreads;
        this.workerPath = workerPath;
        this.workers = [];
        this.taskQueue = [];
        this.freeWorkers = [];

        //  50개로 고정
        for (let i = 0; i < 50; i++) {
            this.addWorkerToPool();
        }
    }

    //  쓰레드 풀에 워커쓰레드 추가
    addWorkerToPool() {
        const worker = new Worker(this.workerPath);

        worker.on('message', (result) => {
            this.freeWorkers.push(worker);

            if (this.taskQueue.length > 0) {
                const { task, callback } = this.taskQueue.shift();
                this.runTask(task, callback);
            }
        });

        worker.on('error', (err) => {
            console.error(err);
            this.workers = this.workers.filter(w => w !== worker);
            this.addWorkerToPool();
        });

        this.workers.push(worker);
        this.freeWorkers.push(worker);
    }

    //
    runTask(task, callback) {
        if (this.freeWorkers.length === 0) {
            this.taskQueue.push({ task, callback });
            return;
        }

        const worker = this.freeWorkers.pop();

        worker.once('message', callback);
        worker.postMessage(task);
    }
}

module.exports = WorkerPool;