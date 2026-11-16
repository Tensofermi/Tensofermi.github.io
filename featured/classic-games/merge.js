const SIZE = 4;
const BEST_KEY = "featured-2048-best";
const directions = { left: "←", up: "↑", down: "↓", right: "→" };
const keys = {
    ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
    a: "left", d: "right", w: "up", s: "down",
};

export function moveTiles(board, direction) {
    const next = Array(SIZE * SIZE).fill(0);
    const horizontal = direction === "left" || direction === "right";
    const reverse = direction === "right" || direction === "down";
    let points = 0;

    for (let lane = 0; lane < SIZE; lane++) {
        const indices = Array.from({ length: SIZE }, (_, offset) => {
            const step = reverse ? SIZE - 1 - offset : offset;
            return horizontal ? lane * SIZE + step : step * SIZE + lane;
        });
        const tiles = indices.map((index) => board[index]).filter(Boolean);
        let output = 0;

        for (let input = 0; input < tiles.length; input++) {
            let value = tiles[input];
            if (value === tiles[input + 1]) {
                value *= 2;
                points += value;
                input++;
            }
            next[indices[output++]] = value;
        }
    }

    return { next, points, changed: next.some((value, index) => value !== board[index]) };
}

export function hasMoves(board) {
    return board.some((tile, index) => tile === 0
        || (index % SIZE < SIZE - 1 && tile === board[index + 1])
        || (index + SIZE < board.length && tile === board[index + SIZE]));
}

function spawn(board) {
    const free = board.flatMap((tile, index) => tile ? [] : [index]);
    if (free.length) board[free[Math.floor(Math.random() * free.length)]] = Math.random() < .9 ? 2 : 4;
}

export function start(ui) {
    let board;
    let score;
    let best = 0;
    try { best = Number(localStorage.getItem(BEST_KEY)) || 0; } catch {}

    ui.board.className = "merge-board";
    ui.board.setAttribute("role", "img");
    const tiles = Array.from({ length: SIZE * SIZE }, () => {
        const element = document.createElement("div");
        element.className = "tile";
        element.setAttribute("aria-hidden", "true");
        return element;
    });
    ui.board.append(...tiles);

    function render() {
        const won = Math.max(...board) >= 2048;
        ui.stats.textContent = "得分 " + score + "　最高分 " + best;
        ui.status.textContent = !hasMoves(board) ? (won ? "已达到 2048，本局结束。" : "棋盘已无法移动，本局结束。")
            : won ? "达成 2048！可以继续合并。" : "";
        const rows = Array.from({ length: SIZE }, (_, row) => board.slice(row * SIZE, (row + 1) * SIZE)
            .map((value) => value || "空").join("、"));
        ui.board.setAttribute("aria-label", "2048 棋盘。各行依次为 " + rows.join("；"));
        tiles.forEach((element, index) => {
            const value = board[index];
            element.textContent = value || "";
            element.dataset.value = value;
            element.dataset.large = String(value >= 2048);
            element.dataset.digits = String(String(value).length);
        });
    }

    function move(direction) {
        const { next, points, changed } = moveTiles(board, direction);
        if (!changed) return;
        board = next;
        score += points;
        if (score > best) {
            best = score;
            try { localStorage.setItem(BEST_KEY, String(best)); } catch {}
        }
        spawn(board);
        render();
    }

    function reset() {
        board = Array(SIZE * SIZE).fill(0);
        score = 0;
        spawn(board);
        spawn(board);
        render();
    }

    document.addEventListener("keydown", (event) => {
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        const direction = keys[event.key] || keys[event.key.toLowerCase()];
        if (!Object.hasOwn(directions, direction)) return;
        event.preventDefault();
        move(direction);
    });
    for (const direction of Object.keys(directions)) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = directions[direction];
        button.setAttribute("aria-label", { left: "左移", right: "右移", up: "上移", down: "下移" }[direction]);
        button.addEventListener("click", () => move(direction));
        ui.controls.append(button);
    }

    let gesture;
    ui.board.addEventListener("pointerdown", (event) => {
        if (!event.isPrimary || event.button !== 0) return;
        gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
        ui.board.setPointerCapture(event.pointerId);
    });
    ui.board.addEventListener("pointercancel", () => { gesture = null; });
    ui.board.addEventListener("pointerup", (event) => {
        if (gesture?.id !== event.pointerId) return;
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        gesture = null;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
        move(Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
    });

    ui.restart.addEventListener("click", reset);
    reset();
}
