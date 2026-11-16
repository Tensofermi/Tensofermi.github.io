const LEVELS = {
    beginner: { size: 9, mines: 10, label: "初级 · 9 × 9" },
    intermediate: { size: 16, mines: 40, label: "中级 · 16 × 16" },
};

export function neighbors(size, index) {
    const result = [];
    const row = Math.floor(index / size);
    const col = index % size;

    for (let y = Math.max(0, row - 1); y <= Math.min(size - 1, row + 1); y++) {
        for (let x = Math.max(0, col - 1); x <= Math.min(size - 1, col + 1); x++) {
            const neighbor = y * size + x;
            if (neighbor !== index) result.push(neighbor);
        }
    }
    return result;
}

export function placeMines(cells, around, first, count, random = Math.random) {
    const safe = new Set([first, ...around[first]]);
    const candidates = cells.flatMap((_, index) => safe.has(index) ? [] : [index]);
    for (let i = 0; i < count; i++) {
        const choice = i + Math.floor(random() * (candidates.length - i));
        [candidates[i], candidates[choice]] = [candidates[choice], candidates[i]];
        const mine = candidates[i];
        cells[mine].mine = true;
        for (const neighbor of around[mine]) cells[neighbor].count++;
    }
}

export function uncover(cells, around, index) {
    const queue = [index];
    let opened = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const position = queue[cursor];
        const cell = cells[position];
        if (cell.open || cell.flag || cell.mine) continue;
        cell.open = true;
        opened++;
        if (cell.count === 0) queue.push(...around[position]);
    }
    return opened;
}

export function start(ui) {
    const level = document.createElement("select");
    for (const [key, { label }] of Object.entries(LEVELS)) level.add(new Option(label, key));
    const label = document.createElement("label");
    label.append("难度 ", level);

    const flagMode = document.createElement("button");
    flagMode.type = "button";
    flagMode.textContent = "插旗模式";
    flagMode.setAttribute("aria-pressed", "false");
    flagMode.addEventListener("click", () => {
        flagMode.setAttribute("aria-pressed", flagMode.getAttribute("aria-pressed") === "false" ? "true" : "false");
    });
    ui.options.append(label, flagMode);
    ui.board.className = "mine-board";
    ui.board.setAttribute("role", "group");
    ui.board.setAttribute("aria-label", "扫雷棋盘");

    let size, mineCount, remaining, exploded, focused;
    let cells, around, buttons;
    let begun;

    function ended() {
        return exploded !== null || remaining === 0;
    }

    function render() {
        const flags = cells.filter((cell) => cell.flag).length;
        ui.stats.textContent = "地雷 " + mineCount + "　已插旗 " + flags;
        ui.status.textContent = exploded !== null ? "踩到雷了。可以重新开始。"
            : remaining === 0 ? "通关！所有安全格都已翻开。"
                : begun ? "还有 " + remaining + " 个安全格" : "翻开第一格开始";

        cells.forEach((cell, index) => {
            const button = buttons[index];
            const row = Math.floor(index / size) + 1;
            const col = index % size + 1;
            let state = "closed";
            let text = "";
            let description = "未翻开";

            if (exploded === index) {
                [state, text, description] = ["exploded", "✹", "踩中的雷"];
            } else if (exploded !== null && !cell.mine && cell.flag) {
                [state, text, description] = ["wrong", "×", "插旗错误"];
            } else if (cell.flag) {
                [state, text, description] = ["flag", "⚑", "已插旗"];
            } else if (exploded !== null && cell.mine) {
                [state, text, description] = ["mine", "✹", "地雷"];
            } else if (cell.open) {
                [state, text, description] = ["open", cell.count || "", "周围 " + cell.count + " 个雷"];
            }

            button.textContent = text;
            button.dataset.state = state;
            button.dataset.count = state === "open" ? cell.count : "";
            button.setAttribute("aria-label", "第 " + row + " 行，第 " + col + " 列，" + description);
            button.setAttribute("aria-disabled", String(ended() || cell.open));
        });
    }

    function flag(index) {
        const cell = cells[index];
        if (cell.open || ended()) return;
        cell.flag = !cell.flag;
        render();
    }

    function reveal(index) {
        const cell = cells[index];
        if (cell.open || cell.flag || ended()) return;
        if (!begun) {
            placeMines(cells, around, index, mineCount);
            begun = true;
        }
        if (cell.mine) exploded = index;
        else {
            remaining -= uncover(cells, around, index);
            if (remaining === 0) {
                for (const cell of cells) cell.flag = cell.mine;
            }
        }
        render();
    }

    function moveFocus(index, event) {
        const row = Math.floor(index / size);
        const col = index % size;
        let next = index;
        switch (event.key) {
            case "ArrowLeft": if (col > 0) next--; break;
            case "ArrowRight": if (col + 1 < size) next++; break;
            case "ArrowUp": if (row > 0) next -= size; break;
            case "ArrowDown": if (row + 1 < size) next += size; break;
            case "f": case "F": event.preventDefault(); flag(index); return;
            default: return;
        }
        event.preventDefault();
        buttons[next].focus();
    }

    function reset() {
        ({ size, mines: mineCount } = LEVELS[level.value]);
        remaining = size * size - mineCount;
        exploded = null;
        focused = 0;
        begun = false;
        flagMode.setAttribute("aria-pressed", "false");
        cells = Array.from({ length: size * size }, () => ({ count: 0, mine: false, open: false, flag: false }));
        around = cells.map((_, index) => neighbors(size, index));
        buttons = cells.map((_, index) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "mine-cell";
            button.tabIndex = index === 0 ? 0 : -1;
            button.addEventListener("click", () => {
                if (flagMode.getAttribute("aria-pressed") === "true") flag(index);
                else reveal(index);
            });
            button.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                flag(index);
            });
            button.addEventListener("keydown", (event) => moveFocus(index, event));
            button.addEventListener("focus", () => {
                buttons[focused].tabIndex = -1;
                button.tabIndex = 0;
                focused = index;
            });
            return button;
        });
        ui.board.dataset.size = size;
        ui.board.style.setProperty("--size", size);
        ui.board.replaceChildren(...buttons);
        render();
    }

    level.addEventListener("change", reset);
    ui.restart.addEventListener("click", reset);
    reset();
}
