 //chart js
Chart.register(ChartDataLabels);


// 금일 전체 코칭 건수
let totalTodayCountArea = document.getElementById('totalTodayCount').getContext('2d');
let totalTodayCountData  = {
  datasets: [
    {
      // Line chart data (first draw goes top layer)
      type : 'line',
      data :[30,150,234,150,151,102,100],
      datalabels : {
        labels : {
          title : null
        }
      },
      //Line chart point custom
      borderWidth : 2,
      borderColor : '#FFB92C',
      pointBackgroundColor : '#fff',
      pointBorderColor : '#FFB92C',
      pointHoverBorderColor : '#FFB92C',
      pointHoverBackgroundColor : '#fff',
      pointBorderWidth : 2,
      pointRadius : 3,
      pointHoverRadius : 3,
      pointHoverBorderWidth : 2
    },
    {
      // Bar chart data
      type: 'bar',
      data :[30,150,234,150,151,102,100],
      backgroundColor: ['#5D93FF'],
      datalabels : {
        labels : {
          title : null
        }
      },
      fill: false,
      borderRadius:	2,
      barPercentage: .8,
      categoryPercentage:.4,
    },
    {
      // Bar chart data
      type: 'bar',
      data: [120,60,130,13,112,40,54],
      backgroundColor: ['#48DCFB'],
      datalabels : {
        labels : {
          title : null
        }
      },
      fill: false,
      borderRadius:	2,
      barPercentage: .8,
      categoryPercentage:.4,
    },
  ],
  labels: ['10:00:00','11:00:00','12:00:00','13:00:00','14:00:00','15:00:00','16:00:00'],
};
// Options for the line chart
const lineChartOptions = {
  responsive : true,
  maintainAspectRatio : false,
  animation : {
    easing : 'easeInOutQuad',
    duration : 520
  },
  plugins : {
    legend : { display : false },
    tooltip : {
      titleFontFamily : 'Noto Sans KR',
      enabled : false,
      position : 'nearest',
      external : function (context) {
        // Tooltip Element
        let tooltipEl = document.getElementById('chartjs-tooltip');
        
        // Create element on first render
        if (!tooltipEl) {
          tooltipEl = document.createElement('div');
          tooltipEl.id = 'chartjs-tooltip';
          tooltipEl.innerHTML = '<div class="wrap"></div>';
          document.body.appendChild(tooltipEl);
        }
        
        // Hide if no tooltip
        const tooltipModel = context.tooltip;
        
        if (tooltipModel.opacity === 0) {
          tooltipEl.style.opacity = 0;
          return;
        }
        
        // Set caret Position
        tooltipEl.classList.remove('above', 'below', 'no-transform');
        if (tooltipModel.yAlign) {
          tooltipEl.classList.add(tooltipModel.yAlign);
        } else {
          tooltipEl.classList.add('no-transform');
        }
        
        function getBody(bodyItem) {
          return bodyItem.lines;
        }
        
        // Set Text
        if (tooltipModel.body) {
          const bodyLines = tooltipModel.body.map(getBody);
          
          let innerHtml = '<p>';
          
          bodyLines.forEach(function (body, i) {
            const colors = tooltipModel.labelColors[i];
            const span = '<span style="color :#fff;">' + body + '</span>';
            innerHtml += span;
          });
          
          innerHtml += '</p>';
          
          let tableRoot = tooltipEl.querySelector('div');
          tableRoot.innerHTML = innerHtml;
        }
        
        const position = context.chart.canvas.getBoundingClientRect();
        const bodyFont = Chart.helpers.toFont(tooltipModel.options.bodyFont);
        
        tooltipEl.style.opacity = 1;
        tooltipEl.style.position = 'absolute';
        tooltipEl.style.left = position.left + tooltipModel.caretX + 'px';
        tooltipEl.style.top = position.top + window.pageYOffset + tooltipModel.caretY  - 30 + 'px';
        tooltipEl.style.font = bodyFont.string;
        tooltipEl.style.pointerEvents = 'none';
        tooltipEl.style.transform = 'translate(-50%, 0)';
        tooltipEl.style.transition = 'all .1s ease';
      }
    }
  },
  scales : {
    x : {
      grid : {
        display : false,
        drawBorder : true,
      },
      ticks : {
        color : '#98A2B3',
        maxRotation : 90,
        padding : 10,
        z : 2,
        font : {
          size : 11,
          family : 'Noto Sans KR',
          weight : 400
        }
      }
    },
    y : {
      afterDataLimits : (scale) => {
        scale.max = scale.max * 1.1;
      },
      beginAtZero : true,
      type : 'linear',
      grid : {
        drawTicks : false,
        drawBorder : false,
        borderDash : [3, 2],
      },
      ticks : {
        color : '#98a2b3',
        font : {
          size : 11,
          family : 'Noto Sans KR',
          weight : 300,
        },
        stepSize : 100,
        padding : 5,
      }
    }
  },
  xAlign : {
    position : 'center'
  },
  point : {
    backgroundColor : '#fff'
  }
};
// Options for the bar chart
let barChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      axis: 'y'
    },
    plugins: {
      legend: {display: false},
    },
    scales: {
      x: {
        grid: {
          display: false,
          // drawBorder: true,
        },
        ticks: {
          color: '#98A2B3',
          maxRotation: 100,
          padding: 5,
          font: {
            size: 11,
            family: "notoSans KR",
            weight: 400,
          },
        }
      },
      y: {
        // afterDataLimits: (scale) => {
        //   scale.max = scale.max * 1.2;
        // },
        beginAtZero: true,
        type: 'linear',
        grid: {
          drawTicks: false,
          drawBorder: false,
          borderDash: [3, 2],
        },
        ticks: {
          color: '#98a2b3',
          font: {
            size: 11,
            family: "Notosans KR",
            weight: 300,
          },
          stepSize: 100,
          padding: 5
        }
      },
    },
};

// combined chart
let totalTodayCountChart = new Chart(totalTodayCountArea, {
  type: 'bar',
  data: totalTodayCountData,
  options: barChartOptions,
});
totalTodayCountChart.config.type = 'line';
totalTodayCountChart.options = lineChartOptions;
totalTodayCountChart.update();

//금일 코칭 현황		
  const recentWeekConfirmdata = {
    labels: [],
    datasets: [{
      label: '',
      data: [1732,700],
      backgroundColor: ['#33DAA2', '#71F37E'],
      borderWidth: 0,
      datalabels: {
        labels: {
          title: null
        }
      }
    }],
  };
const stackText = {
  id : 'recentWeekConfirm',
  afterDatasetsDraw(chart, args, options) {
    const {ctx, chartArea : {top, bottom, left, right, width, height}} = chart;
    ctx.save();
      config.options.cutout = '70%';
      
      ctx.font = `normal 16px  NotoSans KR`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#98A2B3';
      ctx.fillText('Total', width / 2, height / 2 + top - 20);
      ctx.restore();
      
      ctx.font = `bold 38px  NotoSans KR`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#101828';
      ctx.fillText(getTotal(), width / 2, height / 2 + top + 13);
      ctx.restore();
    
    recentWeekConfirmChart.update();
  }
};

const config = {
  type : 'doughnut',
  data: recentWeekConfirmdata,
  options : {
    responsive :true,
    circumference : 360,
    rotation : 0,
    plugins : {
      tooltip : {enabled: false}
    }
  },
  plugins : [stackText]
};

const recentWeekConfirmChart = new Chart(
  document.getElementById('recentWeekConfirm').getContext('2d'),
  config
);

const getTotal = function () {
  const total = recentWeekConfirmdata.datasets[0].data.reduce((sum, value) => sum + value, 0);

  // 천 단위로 쉼표 추가
  return total.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

// 일반문의
const normalCSArea = document.getElementById('normalCS').getContext('2d');
const data1 = 72;
const data2 = 52;
const total = data1 + data2 ;
// const emptySpace = 0;
new Chart(normalCSArea, {
  plugins:[{ 
        beforeRender:function(chart,options){ 
          // 데이터가 0 일때  데이터라벨 표기 위치 변경, 색 변경
          chart.data.datasets.forEach((arr,index)=>{ 
            if(arr.data[0] < 10 ){ // arr숫자는 stepSize 절반으로
              chart.$datalabels._datasets[index][0]._model.align = 'start';
              chart.$datalabels._datasets[index][0]._model.color = 'transparent';
            }
          });
        }
      },
    ],
  type: 'bar',
  data: {
    labels: ['자동코칭'],
    datasets: [
      {  
        axis: 'y',
        data: [(data1 / total * 100)],
        backgroundColor: ['#7856E4'],
        datalabels: {
          formatter : function() { return data1.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "건"; },
          anchor: 'start',
          align: 'end',
          color: '#fff',
          font : function (context) {
              var width = context.chart.width;
              var fontSize;
              
              if (width >= 100) {
                  fontSize = 14;
              } else if (width >= 35) {
                  fontSize = 10;
              } else {
                  fontSize = Math.round(width / 32);
                  fontSize = fontSize > 14 ? 14 : fontSize;
              }
              
              return {
                  size: fontSize,
                  weight: 'normal',
                  family: 'Noto Sans KR'
              };}
        },
        stack: 'stack'
      },
      { 
        axis: 'y',
        data: [(data2 / total * 100)],
        backgroundColor: ['#FFB92C'],
        datalabels: {
          formatter : function() { return data2.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "건"; },
          anchor: 'start',
          align: 'end',
          color: '#fff',
          font : function (context) {
            return {
                size: 14,
                weight: 'normal',
                family: 'Noto Sans KR'
            };
          },
        },
        stack: 'stack'
      }
    ]
  },
  options: {
    indexAxis: 'y',
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip : {
        enabled : false,
      titleFontFamily : 'Noto Sans KR',
      position : 'nearest',
      external : function (context) {
        // Tooltip Element
        let tooltipEl = document.getElementById('chartjs-tooltip');
        
        // Create element on first render
        if (!tooltipEl) {
          tooltipEl = document.createElement('div');
          tooltipEl.id = 'chartjs-tooltip';
          tooltipEl.innerHTML = '<div class="wrap"></div>';
          document.body.appendChild(tooltipEl);
        }
        
        // Hide if no tooltip
        const tooltipModel = context.tooltip;
        
        if (tooltipModel.opacity === 0) {
          tooltipEl.style.opacity = 0;
          return;
        }
        
        // Set caret Position
        tooltipEl.classList.remove('above', 'below', 'no-transform');
        if (tooltipModel.yAlign) {
          tooltipEl.classList.add(tooltipModel.yAlign);
        } else {
          tooltipEl.classList.add('no-transform');
        }
        
        function getBody(bodyItem) {
          return bodyItem.lines;
        }
        
        // Set Text
        if (tooltipModel.body) {
          const bodyLines = tooltipModel.body.map(getBody);
          
          let innerHtml = '<p>';
          bodyLines.forEach(function (body, i) {
            let bodyOrigin = Math.round((body*total)/100) 
            // const colors = tooltipModel.labelColors[i];
            const span = '<span style="color :#fff;">' + bodyOrigin + '</span>';
            innerHtml += span;
          });
          
          innerHtml += '</p>';
          
          let tableRoot = tooltipEl.querySelector('div');
          tableRoot.innerHTML = innerHtml;
        }
        
        const position = context.chart.canvas.getBoundingClientRect();
        const bodyFont = Chart.helpers.toFont(tooltipModel.options.bodyFont);
        
        tooltipEl.style.opacity = 1;
        tooltipEl.style.position = 'absolute';
        tooltipEl.style.left = position.left + tooltipModel.caretX + 'px';
        tooltipEl.style.top = position.top + window.pageYOffset + tooltipModel.caretY  - 30 + 'px';
        tooltipEl.style.font = bodyFont.string;
        tooltipEl.style.pointerEvents = 'none';
        tooltipEl.style.transform = 'translate(-50%, 0)';
        tooltipEl.style.transition = 'all .1s ease';
      }
    },
      datalabels: { display: true }
    },
    scales: {
      x: {
        stacked: true,
        display: false,
      },
      y: {
        stacked: true,
        display: false
      }
    }
  }
});
// 민원접수
const complaintsArea = document.getElementById('complaints').getContext('2d');
const data3 = 3;
const data4 = 5;
const total2 = data3 + data4 ;
// const emptySpace = 0;
new Chart(complaintsArea, {
  plugins:[{ 
        beforeRender:function(chart,options){ 
          // 데이터가 0 일때  데이터라벨 표기 위치 변경, 색 변경
          chart.data.datasets.forEach((arr,index)=>{ 
            if(arr.data[0] < 10 ){ // arr숫자는 stepSize 절반으로
              chart.$datalabels._datasets[index][0]._model.align = 'start';
              chart.$datalabels._datasets[index][0]._model.color = 'transparent';
            }
          });
        }
      },
    ],
  type: 'bar',
  data: {
    labels: ['자동코칭'],
    datasets: [
      {  
        axis: 'y',
        data: [(data3 / total2 * 100)],
        backgroundColor: ['#7856E4'],
        datalabels: {
          formatter : function() { return data3.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "건"; },
          anchor: 'start',
          align: 'end',
          color: '#fff',
          font : function (context) {
              var width = context.chart.width;
              var fontSize;
              
              if (width >= 100) {
                  fontSize = 14;
              } else if (width >= 35) {
                  fontSize = 10;
              } else {
                  fontSize = Math.round(width / 32);
                  fontSize = fontSize > 14 ? 14 : fontSize;
              }
              
              return {
                  size: fontSize,
                  weight: 'normal',
                  family: 'Noto Sans KR'
              };}
        },
        stack: 'stack'
      },
      { 
        axis: 'y',
        data: [(data4 / total2 * 100)],
        backgroundColor: ['#FFB92C'],
        datalabels: {
          formatter : function() { return data4.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "건"; },
          anchor: 'start',
          align: 'end',
          color: '#fff',
          font : function (context) {
            return {
                size: 14,
                weight: 'normal',
                family: 'Noto Sans KR'
            };
          },
        },
        stack: 'stack'
      }
    ]
  },
  options: {
    indexAxis: 'y',
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip : {
        enabled : false,
      titleFontFamily : 'Noto Sans KR',
      position : 'nearest',
      external : function (context) {
        // Tooltip Element
        let tooltipEl = document.getElementById('chartjs-tooltip');
        
        // Create element on first render
        if (!tooltipEl) {
          tooltipEl = document.createElement('div');
          tooltipEl.id = 'chartjs-tooltip';
          tooltipEl.innerHTML = '<div class="wrap"></div>';
          document.body.appendChild(tooltipEl);
        }
        
        // Hide if no tooltip
        const tooltipModel = context.tooltip;
        
        if (tooltipModel.opacity === 0) {
          tooltipEl.style.opacity = 0;
          return;
        }
        
        // Set caret Position
        tooltipEl.classList.remove('above', 'below', 'no-transform');
        if (tooltipModel.yAlign) {
          tooltipEl.classList.add(tooltipModel.yAlign);
        } else {
          tooltipEl.classList.add('no-transform');
        }
        
        function getBody(bodyItem) {
          return bodyItem.lines;
        }
        
        // Set Text
        if (tooltipModel.body) {
          const bodyLines = tooltipModel.body.map(getBody);
          let innerHtml = '<p>';
          bodyLines.forEach(function (body, i) {
            let bodyOrigin = Math.round((body*total2)/100) 
            // const colors = tooltipModel.labelColors[i];
            const span = '<span style="color :#fff;">' + bodyOrigin + '</span>';
            innerHtml += span;
          });
          
          innerHtml += '</p>';
          
          let tableRoot = tooltipEl.querySelector('div');
          tableRoot.innerHTML = innerHtml;
        }
        
        const position = context.chart.canvas.getBoundingClientRect();
        const bodyFont = Chart.helpers.toFont(tooltipModel.options.bodyFont);
        
        tooltipEl.style.opacity = 1;
        tooltipEl.style.position = 'absolute';
        tooltipEl.style.left = position.left + tooltipModel.caretX + 'px';
        tooltipEl.style.top = position.top + window.pageYOffset + tooltipModel.caretY  - 30 + 'px';
        tooltipEl.style.font = bodyFont.string;
        tooltipEl.style.pointerEvents = 'none';
        tooltipEl.style.transform = 'translate(-50%, 0)';
        tooltipEl.style.transition = 'all .1s ease';
      }
    },
      datalabels: { display: true }
    },
    scales: {
      x: {
        stacked: true,
        display: false,
      },
      y: {
        stacked: true,
        display: false
      }
    }
  }
});

//제품판매
const salesArea = document.getElementById('sales').getContext('2d');
const data5 = 18;
const data6 = 50;
const total3 = data5 + data6 ;

// const emptySpace = 0;
new Chart(salesArea, {
  plugins:[{ 
        beforeRender:function(chart,options){ 
          // 데이터가 0 일때  데이터라벨 표기 위치 변경, 색 변경
          chart.data.datasets.forEach((arr,index)=>{ 
            if(arr.data[0] < 10 ){ // arr숫자는 stepSize 절반으로
              chart.$datalabels._datasets[index][0]._model.align = 'start';
              chart.$datalabels._datasets[index][0]._model.color = 'transparent';
            }
          });
        }
      },
    ],
  type: 'bar',
  data: {
    labels: [''],
    datasets: [
      {  
        axis: 'y',
        data: [(data5 / total3 * 100)],
        backgroundColor: ['#7856E4'],
        datalabels: {
          formatter : function() { return data5.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "건"; },
          anchor: 'start',
          align: 'end',
          color: '#fff',
          font : function (context) {
              var width = context.chart.width;
              var fontSize;
              
              if (width >= 100) {
                  fontSize = 14;
              } else if (width >= 35) {
                  fontSize = 10;
              } else {
                  fontSize = Math.round(width / 32);
                  fontSize = fontSize > 14 ? 14 : fontSize;
              }
              
              return {
                  size: fontSize,
                  weight: 'normal',
                  family: 'Noto Sans KR'
              };}
        },
        stack: 'stack'
      },
      { 
        axis: 'y',
        data: [(data6 / total3 * 100)],
        backgroundColor: ['#FFB92C'],
        datalabels: {
          formatter : function() { return data6.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "건"; },
          anchor: 'start',
          align: 'end',
          color: '#fff',
          font : function (context) {
            return {
                size: 14,
                weight: 'normal',
                family: 'Noto Sans KR'
            };
          },
        },
        stack: 'stack'
      }
    ]
  },
  options: {
    indexAxis: 'y',
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip : {
        enabled : false,
      titleFontFamily : 'Noto Sans KR',
      position : 'nearest',
      external : function (context) {
        // Tooltip Element
        let tooltipEl = document.getElementById('chartjs-tooltip');
        
        // Create element on first render
        if (!tooltipEl) {
          tooltipEl = document.createElement('div');
          tooltipEl.id = 'chartjs-tooltip';
          tooltipEl.innerHTML = '<div class="wrap"></div>';
          document.body.appendChild(tooltipEl);
        }
        
        // Hide if no tooltip
        const tooltipModel = context.tooltip;
        
        if (tooltipModel.opacity === 0) {
          tooltipEl.style.opacity = 0;
          return;
        }
        
        // Set caret Position
        tooltipEl.classList.remove('above', 'below', 'no-transform');
        if (tooltipModel.yAlign) {
          tooltipEl.classList.add(tooltipModel.yAlign);
        } else {
          tooltipEl.classList.add('no-transform');
        }
        
        function getBody(bodyItem) {
          return bodyItem.lines;
        }
        
        // Set Text
        if (tooltipModel.body) {
          const bodyLines = tooltipModel.body.map(getBody);
          let innerHtml = '<p>';
          bodyLines.forEach(function (body, i) {
            let bodyOrigin = Math.round((body*total3)/100) 
            // const colors = tooltipModel.labelColors[i];
            const span = '<span style="color :#fff;">' + bodyOrigin + '</span>';
            innerHtml += span;
          });
          
          innerHtml += '</p>';
          
          let tableRoot = tooltipEl.querySelector('div');
          tableRoot.innerHTML = innerHtml;
        }
        
        const position = context.chart.canvas.getBoundingClientRect();
        const bodyFont = Chart.helpers.toFont(tooltipModel.options.bodyFont);
        
        tooltipEl.style.opacity = 1;
        tooltipEl.style.position = 'absolute';
        tooltipEl.style.left = position.left + tooltipModel.caretX + 'px';
        tooltipEl.style.top = position.top + window.pageYOffset + tooltipModel.caretY  - 30 + 'px';
        tooltipEl.style.font = bodyFont.string;
        tooltipEl.style.pointerEvents = 'none';
        tooltipEl.style.transform = 'translate(-50%, 0)';
        tooltipEl.style.transition = 'all .1s ease';
      }
    },
      datalabels: { display: true }
    },
    scales: {
      x: {
        stacked: true,
        display: false,
      },
      y: {
        stacked: true,
        display: false
      }
    }
  }
});
// 기타접수
const etcArea = document.getElementById('etc').getContext('2d');
const data7 = 12;
const data8 = 169;
const total4 = data7 + data8 ;

// const emptySpace = 0;
new Chart(etcArea, {
  plugins:[{ 
        beforeRender:function(chart,options){ 
          // 데이터가 0 일때  데이터라벨 표기 위치 변경, 색 변경
          chart.data.datasets.forEach((arr,index)=>{ 
            if(arr.data[0] < 10 ){ // arr숫자는 stepSize 절반으로
              chart.$datalabels._datasets[index][0]._model.align = 'start';
              chart.$datalabels._datasets[index][0]._model.color = 'transparent';
            }
          });
        }
      },
    ],
  type: 'bar',
  data: {
    labels: [''],
    datasets: [
      {  
        axis: 'y',
        data: [(data7 / total4 * 100)],
        backgroundColor: ['#7856E4'],
        datalabels: {
          formatter : function() { return data7.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "건"; },
          anchor: 'start',
          align: 'end',
          color: '#fff',
          font : function (context) {
              var width = context.chart.width;
              var fontSize;
              
              if (width >= 100) {
                  fontSize = 14;
              } else if (width >= 35) {
                  fontSize = 10;
              } else {
                  fontSize = Math.round(width / 32);
                  fontSize = fontSize > 14 ? 14 : fontSize;
              }
              
              return {
                  size: fontSize,
                  weight: 'normal',
                  family: 'Noto Sans KR'
              };}
        },
        stack: 'stack'
      },
      { 
        axis: 'y',
        data: [(data8 / total4 * 100)],
        backgroundColor: ['#FFB92C'],
        datalabels: {
          formatter : function() { return data8.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "건"; },
          anchor: 'start',
          align: 'end',
          color: '#fff',
          font : function (context) {
            return {
                size: 14,
                weight: 'normal',
                family: 'Noto Sans KR'
            };
          },
        },
        stack: 'stack'
      }
    ]
  },
  options: {
    indexAxis: 'y',
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip : {
        enabled : false,
      titleFontFamily : 'Noto Sans KR',
      position : 'nearest',
      external : function (context) {
        // Tooltip Element
        let tooltipEl = document.getElementById('chartjs-tooltip');
        
        // Create element on first render
        if (!tooltipEl) {
          tooltipEl = document.createElement('div');
          tooltipEl.id = 'chartjs-tooltip';
          tooltipEl.innerHTML = '<div class="wrap"></div>';
          document.body.appendChild(tooltipEl);
        }
        
        // Hide if no tooltip
        const tooltipModel = context.tooltip;
        
        if (tooltipModel.opacity === 0) {
          tooltipEl.style.opacity = 0;
          return;
        }
        
        // Set caret Position
        tooltipEl.classList.remove('above', 'below', 'no-transform');
        if (tooltipModel.yAlign) {
          tooltipEl.classList.add(tooltipModel.yAlign);
        } else {
          tooltipEl.classList.add('no-transform');
        }
        
        function getBody(bodyItem) {
          return bodyItem.lines;
        }
        
        // Set Text
        if (tooltipModel.body) {
          const bodyLines = tooltipModel.body.map(getBody);
          let innerHtml = '<p>';
          bodyLines.forEach(function (body, i) {
            let bodyOrigin = Math.round((body*total4)/100) 
            // const colors = tooltipModel.labelColors[i];
            const span = '<span style="color :#fff;">' + bodyOrigin + '</span>';
            innerHtml += span;
          });
          
          innerHtml += '</p>';
          
          let tableRoot = tooltipEl.querySelector('div');
          tableRoot.innerHTML = innerHtml;
        }
        
        const position = context.chart.canvas.getBoundingClientRect();
        const bodyFont = Chart.helpers.toFont(tooltipModel.options.bodyFont);
        
        tooltipEl.style.opacity = 1;
        tooltipEl.style.position = 'absolute';
        tooltipEl.style.left = position.left + tooltipModel.caretX + 'px';
        tooltipEl.style.top = position.top + window.pageYOffset + tooltipModel.caretY  - 30 + 'px';
        tooltipEl.style.font = bodyFont.string;
        tooltipEl.style.pointerEvents = 'none';
        tooltipEl.style.transform = 'translate(-50%, 0)';
        tooltipEl.style.transition = 'all .1s ease';
      }
    },
      datalabels: { display: true }
    },
    scales: {
      x: {
        stacked: true,
        display: false,
      },
      y: {
        stacked: true,
        display: false
      }
    }
  }
});