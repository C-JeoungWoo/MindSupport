'use strict'

// 현재 경로를 서버에 저장
function saveCurrentPath(path) {
  $.ajax({
    url: '/saveCurrentPath',
    method: 'POST',
    contentType: 'application/json',
    data: JSON.stringify({ path: path }),
    success: response => {
      console.log(`[ main.js:saveCurrentPath ] 경로 저장 성공`);
      console.log(`[ main.js:saveCurrentPath ] 경로 ${path}`);
      console.log(response);
    },
    error: (xhr, status, err) => {
      console.error(`[ main.js:saveCurrentPath ] 경로 저장 실패: ${err}`);
    }
  });
}

//  SELECT BOX
function selectBox(e){
  $(e).parent().toggleClass('active');
  const boxLabel = $(e);
  const list = $(e).parent().find('.list');
  const items = list.find('.item');
  let a =items.find('a');
  
  a.click(function(event){
    event.preventDefault();
    const text = $(this).text();
    $(this).parents().find(boxLabel).text(text).addClass('active');
    $('.select').removeClass('active');
  });
}

//  header.ejs 메뉴 링크 적용
function headerInit() {
  console.log(`[ index.ejs:workStatusMain ] headerInit 호출`);

  //  근무현황 버튼 클릭시
  $('#workStatusMain').click(e => {
    console.log(`[ index.ejs:workStatusMain ] 코칭현황 버튼 클릭`);
    //  폼 제출, 링크 클릭 등의 기본 브라우저 동작을 막고, 사용자 정의 동작을 수행하기 위해 사용
    // e.preventDefault();

    // workStatusMain.ejs 로드
    $.ajax({
      url: '/workStatusMain',  // 실제 요청 URL
      method: 'GET',
      success: function(response) {
        console.log('Response received:', response);
        $(`#container`).empty();
        
        // HTML 내용을 #container에 삽입
        $('#container').html(response.html);
        
        // 페이지 제목 변경
        document.title = response.title;
        
        console.log('Page updated');
      },
      error: function(xhr, status, err) {
        console.error('Error loading page:', err);
        alert('페이지 로드 중 오류가 발생했습니다.');
      }
    });
  });

  //  코칭현황
  $('#coachingMain').click(e => {
    e.preventDefault();

    // coachingMain.ejs 로드가 완료된 후에 실행될 코드
    $.ajax({
      url: `/coachingMain`,
      method: `GET`,
      success: data => {
        console.log(`[ main.js:coachingMain ] AJAX 통신 성공`);
        document.title = data.title;
        $(`#container`).html(data.html);
      },
      error: (xhr, status, err) => {
        console.error(`[ main.js:coachingMain ] ${err}`);
      }
    });
  });
    
  //  감성현황
  $('#emotionStatus').click(e => {
    e.preventDefault();

    // emotionStatus.ejs 로드가 완료된 후에 AJAX
    $.ajax({
      url: `/emotionStatus`,
      method: `GET`,
      success: data => {
        console.log(`[ main.js:emotionStatus ] AJAX 통신 성공`);
        document.title = data.title;
        $(`#container`).html(data.html);
      },
      error: (xhr, status, err) => {
        console.error(`[ main.js:ajax ] ${err}`);
      }
    });
  });

  //  코칭이력
  $('#coachingHistory').click(e => {
    e.preventDefault();

    // coachingHistory.ejs 로드가 완료된 후에 실행될 코드
    $(".datepicker").datepicker();

    $.ajax({
      url: `/coachingHistory`,
      method: `GET`,
      success: data => {
        console.log(`[ main.js:coachingHistory ] AJAX 통신 성공`);
        document.title =  data.title;
        $(`#container`).html(data.html);
      },
      error: (xhr, status, err) => {
        console.error(`[ main.js:coachingHistory ] ${err}`);
      }
    });
  });

  //  코칭조건 설정
  $('#coachingSetting').click(e => {
    e.preventDefault();

    $("#container").load("/coachingSetting", () => {
        // coachingSetting.ejs 로드가 완료된 후에 실행될 코드
        $(".datepicker").datepicker();

        $.ajax({
          url: `/coachingSetting`,
          method: `GET`,
          success: data => {
            console.log(`[ main.js:coachingSetting ] AJAX 통신 성공`);
            $(`#container`).empty();

            document.title = data.title;
            $(`#container`).html(data.html);
          },
          error: (xhr, status, err) => {
            console.error(`[ main.js:coachingSetting ] ${err}`);
          }
        });
    });
  });

  //  관리자 코칭
  $('#coachingAdmin').click(e => {
    e.preventDefault();

    $("#container").load("/coachingAdmin", () => {
        // coachingAdmin.ejs 로드가 완료된 후에 실행될 코드
        $(".datepicker").datepicker();

        $.ajax({
          url: `/coachingAdmin`,
          method: `GET`,
          success: data => {
            console.log(`[ main.js:coachingAdmin ] AJAX 통신 성공`);
            $(`#container`).empty();

            document.title =  data.title;
            $(`#container`).html(data.html);
          },
          error: (xhr, status, err) => {
            console.error(`[ main.js:coachingAdmin ] ${err}`);
          }
        });
    });
  });
  
  //  요약통계
  $('#statsSummary').click(e => {
    e.preventDefault();

    // statsSummary.ejs 로드가 완료된 후에 AJAX
    $("#container").load("/statsSummary", () => {       
        $(".datepicker").datepicker();

        $.ajax({
          url: `/statsSummary`,
          method: `GET`,
          success: data => {
            console.log(`[ main.js:statsSummary ] AJAX 통신 성공`);
            $(`#container`).empty();

            document.title = data.title;
            $(`#container`).html(data.html);
          },
          error: (xhr, status, err) => {
            console.error(`[ main.js:statsSummary ] ${err}`);
          }
        });
    });
  });

  //  상세통계
  $(`#statsDetail`).click(e => {
      e.preventDefault();

      // statsDetail.ejs 로드가 완료된 후에 AJAX
      $("#container").load(`/statsDetail`, () => {          
          $(".datepicker").datepicker();

          $.ajax({
            url: `/statsDetail`,
            method: `GET`,
            success: data => {
              console.log(`[ main.js:statsDetail ] AJAX 통신 성공`);
              $(`#container`).empty();

              document.title = data.title;
              $(`#container`).html(data.html);
            },
            error: (xhr, status, err) => {
              console.error(`[ main.js:statsDetail ] ${err}`);
            }
          });
      });
  });

  //  사용자 관리
  $('#settingUser').click(e => {
      e.preventDefault();

      // settingUser.ejs 로드가 완료된 후 AJAX
      $("#container").load("/settingUser", () => {
          $(".datepicker").datepicker();

          $.ajax({
            url: `/settingUser`,
            method: `GET`,
            success: data => {
              console.log(`[ main.js:settingUser ] AJAX 통신 성공`);
              $(`#container`).empty();

              document.title = data.title;
              $(`#container`).html(data.html);
            },
            error: (xhr, status, err) => {
              console.error(`[ main.js:settingUser ] ${err}`);
            }
          });
      });
  });

  //  메모 관리
  $('#settingMemo').click(e => {
    e.preventDefault();

    // workStatusMain.ejs 로드가 완료된 후에 AJAX
    $("#container").load("/settingMemo", () => {
        $(".datepicker").datepicker();

        $.ajax({
          url: `/settingMemo`,
          method: `GET`,
          success: data => {
            console.log(`[ main.js:settingMemo ] AJAX 통신 성공`);
            
            document.title = data.title;
            $(`#container`).empty();
            $(`#container`).html(data.html);
          },
          error: (xhr, status, err) => {
            console.error(`[ main.js:settingMemo ] ${err}`);
          }
        });
    });
  });
};