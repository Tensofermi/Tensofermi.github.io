import { ABI, Cpu, MEMORY_BASE, MEMORY_SIZE, assemble, parseInteger, toHex } from "./cpu.mjs";

const examples = {
    sum: `# 求 1 + 2 + … + 10；结果 55 存在 a0 和 0x1000。
li a0, 0
li t0, 1
li t1, 11
loop:
    add a0, a0, t0
    addi t0, t0, 1
    blt t0, t1, loop

lui t2, 1
sw a0, 0(t2)
ebreak`,
    memory: `# 0x89abcdef 从 0x1000 开始依次写成 ef cd ab 89。
lui t0, 1
li t1, 0x89abcdef
sw t1, 0(t0)

lb a0, 0(t0)      # 符号扩展：-17
lbu a1, 0(t0)     # 零扩展：239
lhu a2, 2(t0)     # 0x89ab
lw a3, 0(t0)      # 0x89abcdef
ebreak`,
    math: `# 负数除法向零截断。除以零时按 RISC-V 规则写回。
li t0, -17
li t1, 5
mul a0, t0, t1    # -85
div a1, t0, t1    # -3
rem a2, t0, t1    # -2
div a3, t0, zero  # -1
rem a4, t0, zero  # -17
ebreak`,
    call: `# jal 把返回地址写入 ra，ret 用它回到调用点。
li a0, 21
jal ra, twice
ebreak

twice:
    add a0, a0, a0
    ret`,
};

const elem = (id) => document.getElementById(id);
const source = elem("source");
const sample = elem("sample");
const status = elem("status");
const stepButton = elem("step");
const runButton = elem("run");
const assembleButton = elem("assemble");
const resetButton = elem("reset");
const hex = elem("hex");
const decimal = elem("decimal");
const memoryAddress = elem("memory-address");
const memoryInfo = elem("memory-info");
const MAX_STEPS = 50_000;
const STEPS_PER_FRAME = 512;
const VIEW_WORDS = 8;

let cpu;
let assembledSource = "";
let running = false;
let frameId;
let stepsLeft = 0;
let failed = false;
let displayHex = true;
let memoryStart = MEMORY_BASE;

const registerCells = ABI.map((alias, index) => {
    const cell = document.createElement("div");
    cell.className = "register-cell";
    const name = document.createElement("span");
    name.className = "register-name";
    name.textContent = "x" + index + " " + alias;
    const value = document.createElement("output");
    cell.append(name, value);
    elem("registers").append(cell);
    return { cell, value, previous: 0 };
});

const memoryRows = Array.from({ length: VIEW_WORDS }, () => {
    const row = document.createElement("tr");
    const cells = Array.from({ length: 6 }, () => row.insertCell());
    elem("memory").append(row);
    return cells;
});

function announce(message, error = false) {
    status.textContent = message;
    status.classList.toggle("error", error);
}

function writeText(element, value) {
    if (element.textContent !== value) element.textContent = value;
}

function paintMemory(highlight) {
    const lastWrite = highlight ? cpu?.lastWrite : null;
    memoryRows.forEach((cells, index) => {
        const start = memoryStart + index * 4;
        const position = start - MEMORY_BASE;
        writeText(cells[0], toHex(start, 4));
        for (let i = 0; i < 4; i++) {
            const address = start + i;
            writeText(cells[i + 1], cpu ? cpu.memory.getUint8(position + i).toString(16).padStart(2, "0") : "00");
            cells[i + 1].toggleAttribute("data-written", !!lastWrite &&
                address >= lastWrite.address && address < lastWrite.address + lastWrite.width);
        }
        writeText(cells[5], cpu ? toHex(cpu.memory.getUint32(position, true)) : "0x00000000");
    });
}

function paint(highlight = false) {
    const pc = cpu?.pc ?? 0;
    const current = cpu?.halted ? null : cpu?.current();
    elem("pc").textContent = toHex(pc);
    elem("count").textContent = (cpu?.count ?? 0).toLocaleString("zh-CN");
    elem("next-address").textContent = current ? "第 " + (current.line + 1) + " 行" : "";
    elem("next-source").textContent = current
        ? current.source + (current.expansion ? " [" + current.expansion + "]" : "")
        : cpu?.halted ? "程序已结束" : "—";
    elem("next-word").textContent = current ? toHex(cpu.program.words[pc / 4]) : "";

    registerCells.forEach(({ cell, value, previous }, index) => {
        const number = cpu?.registers[index] ?? 0;
        const formatted = displayHex ? toHex(number) : String(number);
        writeText(value, formatted);
        cell.toggleAttribute("data-changed", highlight && number !== previous);
        registerCells[index].previous = number;
    });
    paintMemory(highlight);

    const dirty = source.value !== assembledSource;
    stepButton.disabled = !cpu || cpu.halted || running || failed || dirty;
    runButton.disabled = !running && (!cpu || cpu.halted || failed || dirty);
    writeText(runButton, running ? "暂停" : "运行");
    resetButton.disabled = !cpu || dirty;
    assembleButton.disabled = running;
    source.readOnly = running;
    sample.disabled = running;
    hex.setAttribute("aria-pressed", String(displayHex));
    decimal.setAttribute("aria-pressed", String(!displayHex));
}

function stopRun() {
    running = false;
    cancelAnimationFrame(frameId);
}

function assembleSource() {
    stopRun();
    failed = false;
    try {
        cpu = new Cpu(assemble(source.value));
        assembledSource = source.value;
        announce("已汇编 " + cpu.program.words.length + " 条机器指令。");
    } catch (error) {
        cpu = null;
        assembledSource = "";
        announce(error.message, true);
    }
    paint();
}

function loadSample() {
    source.value = examples[sample.value];
    memoryStart = MEMORY_BASE;
    memoryAddress.value = toHex(memoryStart, 4);
    memoryInfo.classList.remove("error");
    memoryInfo.textContent = "每行 4 字节，按地址从低到高排列。";
    assembleSource();
}

function finishStep() {
    if (!cpu.halted) return;
    stopRun();
    announce("执行 ebreak，程序结束。");
}

function fail(error) {
    stopRun();
    failed = true;
    const line = cpu.current()?.line;
    const location = line === undefined ? "" : "第 " + (line + 1) + " 行：";
    announce(location + error.message, true);
}

function runSlice() {
    if (!running) return;
    try {
        const slice = Math.min(stepsLeft, STEPS_PER_FRAME);
        for (let index = 0; index < slice && !cpu.halted; index++) {
            cpu.step();
            stepsLeft--;
        }
        if (cpu.halted) finishStep();
        else if (stepsLeft === 0) {
            stopRun();
            announce("已执行 50,000 步并暂停。检查循环，或再次点击运行继续。");
        }
    } catch (error) {
        fail(error);
    }
    paint(true);
    if (running) frameId = requestAnimationFrame(runSlice);
}

sample.addEventListener("change", loadSample);
assembleButton.addEventListener("click", assembleSource);
source.addEventListener("input", () => {
    announce(source.value === assembledSource ? "当前源码已汇编。" : "源码有改动，请重新汇编。");
    paint();
});
stepButton.addEventListener("click", () => {
    try {
        cpu.step();
        if (cpu.halted) finishStep();
        else announce("已单步执行。高亮为刚刚变化的寄存器或内存字节。");
    } catch (error) {
        fail(error);
    }
    paint(true);
});
runButton.addEventListener("click", () => {
    if (running) {
        stopRun();
        announce("已暂停，可以单步检查或继续运行。");
        paint();
        return;
    }
    running = true;
    stepsLeft = MAX_STEPS;
    announce("正在运行。");
    paint();
    frameId = requestAnimationFrame(runSlice);
});
resetButton.addEventListener("click", () => {
    stopRun();
    cpu = new Cpu(cpu.program);
    failed = false;
    announce("寄存器和内存已清零，PC 回到起点。");
    paint();
});
hex.addEventListener("click", () => {
    displayHex = true;
    paint();
});
decimal.addEventListener("click", () => {
    displayHex = false;
    paint();
});
elem("memory-form").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
        const address = parseInteger(memoryAddress.value.trim());
        if (address < MEMORY_BASE || address >= MEMORY_BASE + MEMORY_SIZE) {
            throw new Error("请输入 0x1000 至 0x1fff 之间的地址。");
        }
        memoryStart = Math.min(address & ~3, MEMORY_BASE + MEMORY_SIZE - VIEW_WORDS * 4);
        memoryAddress.value = toHex(memoryStart, 4);
        memoryInfo.classList.remove("error");
        memoryInfo.textContent = "每行 4 字节，按地址从低到高排列。";
        paintMemory(false);
    } catch (error) {
        memoryInfo.classList.add("error");
        memoryInfo.textContent = error.message;
    }
});

loadSample();
