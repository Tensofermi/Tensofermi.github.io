const games = {
    "2048": {
        title: "2048",
        rules: "移动方块，相同的数字相撞就会合并。用方向键、WASD、滑动或下方按钮操作，试着拼出 2048。",
        load: () => import("./merge.js"),
    },
    mines: {
        title: "扫雷",
        rules: "数字表示周围的雷数。点按翻开，右键或 F 插旗，手机可切换插旗模式。第一格保证安全。",
        load: () => import("./mines.js"),
    },
    "tic-tac-toe": {
        title: "井字棋",
        rules: "× 和 ○ 轮流落子，先在横、竖或斜线上连成三枚的一方获胜。",
        load: () => import("./tic-tac-toe.js"),
    },
};

function byId(id) {
    return document.getElementById(id);
}

const requested = new URLSearchParams(location.search).get("game");
const gameId = Object.hasOwn(games, requested) ? requested : "2048";
const game = games[gameId];
document.querySelector('[data-game="' + gameId + '"]').setAttribute("aria-current", "page");
document.title = game.title + " · Tensofermi";
byId("title").textContent = game.title;
byId("rules").textContent = game.rules;

try {
    const { start } = await game.load();
    const ui = Object.fromEntries(["board", "options", "stats", "status", "controls", "restart"]
        .map((id) => [id, byId(id)]));
    start(ui);
    document.querySelector(".play").hidden = false;
    ui.restart.hidden = false;
} catch (error) {
    console.error(error);
    byId("load-error").hidden = false;
}
