const LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
];
const ORDER = [4, 0, 2, 6, 8, 1, 3, 5, 7];
const MARKS = { X: "×", O: "○" };

export function winningLine(board) {
    return LINES.find(([a, b, c]) => board[a] && board[a] === board[b] && board[a] === board[c]);
}

function score(board, player, depth) {
    const line = winningLine(board);
    if (line) return board[line[0]] === "O" ? 10 - depth : depth - 10;
    if (board.every(Boolean)) return 0;

    let result = player === "O" ? -Infinity : Infinity;
    for (const index of ORDER) {
        if (board[index]) continue;
        board[index] = player;
        const outcome = score(board, player === "O" ? "X" : "O", depth + 1);
        board[index] = "";
        result = player === "O" ? Math.max(result, outcome) : Math.min(result, outcome);
    }
    return result;
}

export function bestMove(board) {
    const search = board.slice();
    let move = -1;
    let maximum = -Infinity;
    for (const index of ORDER) {
        if (search[index]) continue;
        search[index] = "O";
        const outcome = score(search, "X", 1);
        search[index] = "";
        if (outcome > maximum) {
            maximum = outcome;
            move = index;
        }
    }
    return move;
}

export function start(ui) {
    const mode = document.createElement("select");
    mode.add(new Option("人机对弈", "computer"));
    mode.add(new Option("同屏双人", "local"));
    const label = document.createElement("label");
    label.append("对局模式 ", mode);
    ui.options.append(label);

    let board, turn;
    ui.board.className = "ttt-board";
    ui.board.setAttribute("role", "group");
    ui.board.setAttribute("aria-label", "井字棋棋盘");
    const buttons = Array.from({ length: 9 }, (_, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ttt-cell";
        button.addEventListener("click", () => play(index));
        return button;
    });
    ui.board.append(...buttons);

    function render() {
        const line = winningLine(board);
        const winner = line && board[line[0]];
        const vsComputer = mode.value === "computer";
        const draw = board.every(Boolean);
        ui.status.textContent = winner ? (vsComputer ? (winner === "X" ? "你赢了！" : "电脑获胜。") : MARKS[winner] + " 获胜！")
            : draw ? "平局。" : vsComputer ? "轮到你（×）。" : "轮到 " + MARKS[turn] + "。";
        buttons.forEach((button, index) => {
            const mark = board[index];
            button.textContent = MARKS[mark] || "";
            button.dataset.mark = mark;
            button.dataset.win = String(line?.includes(index) ?? false);
            button.setAttribute("aria-disabled", String(Boolean(mark || winner || draw)));
            button.setAttribute("aria-label", "第 " + (Math.floor(index / 3) + 1) + " 行，第 " + (index % 3 + 1)
                + " 列，" + (MARKS[mark] || "空"));
        });
    }

    function play(index) {
        if (board[index] || winningLine(board)) return;
        board[index] = turn;
        if (mode.value === "computer") {
            if (!winningLine(board) && board.includes("")) board[bestMove(board)] = "O";
        } else {
            turn = turn === "X" ? "O" : "X";
        }
        render();
    }

    function reset() {
        board = Array(9).fill("");
        turn = "X";
        render();
    }

    mode.addEventListener("change", reset);
    ui.restart.addEventListener("click", reset);
    reset();
}
