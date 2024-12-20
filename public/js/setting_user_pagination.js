'use strict'

document.addEventListener("DOMContentLoaded", function() {
    const manageUsers = [
        // Sample data, replace this with your actual data
        { org_id: "001", org_name: "기관A", agent_id: "agent1", agent_name: "상담원1", user_type: 1, age: 30, sex: "남", dev_platform: 2, note: null },
        { org_id: "002", org_name: "기관B", agent_id: "agent2", agent_name: "상담원2", user_type: 0, age: 25, sex: "여", dev_platform: 1, note: "Note1" },
        // Add more rows as needed
    ];

    const rowsPerPage = 10;
    let currentPage = 1;

    function renderTablePage(page) {
        const tableBody = document.querySelector("#table-body");
        tableBody.innerHTML = "";

        const start = (page - 1) * rowsPerPage;
        const end = start + rowsPerPage;
        const paginatedData = manageUsers.slice(start, end);

        for (let i = 0; i < paginatedData.length; i++) {
            const row = paginatedData[i];
            const rowElement = document.createElement("tr");

            rowElement.innerHTML = `
                <td><input id="chkCondition" type="checkbox" name="row_CheckBox"></td>
                <td>${start + i + 1}</td>
                <td>${row.org_id}</td>
                <td>${row.org_name}</td>
                <td>${row.agent_id}</td>
                <td>${row.agent_name}</td>
                <td>${row.user_type == 1 ? "관리자" : "상담원"}</td>
                <td>${row.age}</td>
                <td>${row.sex}</td>
                <td>${row.dev_platform == 2 ? "Windows" : "Mac"}</td>
                <td>${row.note ? row.note : "없음"}</td>
            `;

            tableBody.appendChild(rowElement);
        }
    }

    function setupPagination() {
        const pagination = document.getElementById("pagination");
        const totalPages = Math.ceil(manageUsers.length / rowsPerPage);
        const pageButtonsContainer = pagination.querySelectorAll("li")[2].parentElement;
        pageButtonsContainer.innerHTML = `
            <li><a href="#" class="arrow btnPrevend" aria-label="목록 처음으로" role="button"></a></li>
            <li><a href="#" class="arrow btnPrev" aria-label="목록 앞으로" role="button"></a></li>
        `;

        for (let i = 1; i <= totalPages; i++) {
            const li = document.createElement("li");
            if (i === currentPage) {
                li.classList.add("on");
            }
            const a = document.createElement("a");
            a.href = "#";
            a.textContent = i;
            a.setAttribute("aria-label", "목록 리스트");
            a.setAttribute("role", "button");
            a.addEventListener("click", (e) => {
                e.preventDefault();
                currentPage = i;
                renderTablePage(currentPage);
                setupPagination();
            });
            li.appendChild(a);
            pageButtonsContainer.appendChild(li);
        }

        const prev = pagination.querySelector(".btnPrev");
        const prevEnd = pagination.querySelector(".btnPrevend");
        const next = pagination.querySelector(".btnNext");
        const nextEnd = pagination.querySelector(".btnNextend");

        prev.addEventListener("click", (e) => {
            e.preventDefault();
            if (currentPage > 1) {
                currentPage--;
                renderTablePage(currentPage);
                setupPagination();
            }
        });

        prevEnd.addEventListener("click", (e) => {
            e.preventDefault();
            currentPage = 1;
            renderTablePage(currentPage);
            setupPagination();
        });

        next.addEventListener("click", (e) => {
            e.preventDefault();
            if (currentPage < totalPages) {
                currentPage++;
                renderTablePage(currentPage);
                setupPagination();
            }
        });

        nextEnd.addEventListener("click", (e) => {
            e.preventDefault();
            currentPage = totalPages;
            renderTablePage(currentPage);
            setupPagination();
        });

        pageButtonsContainer.appendChild(next);
        pageButtonsContainer.appendChild(nextEnd);
    }

    renderTablePage(currentPage);
    setupPagination();
});