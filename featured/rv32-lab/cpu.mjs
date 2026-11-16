export const MEMORY_BASE = 0x1000;
export const MEMORY_SIZE = 0x1000;
const MAX_WORDS = 512;

export const ABI = [
    "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2",
    "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5",
    "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7",
    "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6",
];

const registerNames = new Map(ABI.map((name, index) => [name, index]));
registerNames.set("fp", 8);
for (let index = 0; index < 32; index++) registerNames.set("x" + index, index);

const registers = {
    add: [0, 0], sub: [0, 32], sll: [1, 0], slt: [2, 0], sltu: [3, 0],
    xor: [4, 0], srl: [5, 0], sra: [5, 32], or: [6, 0], and: [7, 0],
    mul: [0, 1], mulh: [1, 1], mulhsu: [2, 1], mulhu: [3, 1],
    div: [4, 1], divu: [5, 1], rem: [6, 1], remu: [7, 1],
};
const immediates = { addi: 0, slti: 2, sltiu: 3, xori: 4, ori: 6, andi: 7 };
const shifts = { slli: [1, 0], srli: [5, 0], srai: [5, 32] };
const branches = { beq: 0, bne: 1, blt: 4, bge: 5, bltu: 6, bgeu: 7 };
const loads = { lb: 0, lh: 1, lw: 2, lbu: 4, lhu: 5 };
const stores = { sb: 0, sh: 1, sw: 2 };
const upper = { lui: 0x37, auipc: 0x17 };
const EBREAK = 0x00100073;

export function parseInteger(value) {
    const match = /^([+-]?)(0x[\da-f]+|0b[01]+|\d+)$/i.exec(value ?? "");
    if (!match) throw new Error("无效整数「" + (value ?? "") + "」。");
    const number = Number(match[2]) * (match[1] === "-" ? -1 : 1);
    if (!Number.isSafeInteger(number)) throw new Error("整数超出范围。");
    return number;
}

function bounded(number, min, max, what) {
    if (number < min || number > max) throw new Error(what + "范围为 " + min + " 至 " + max + "。");
    return number;
}

function reg(token) {
    const index = registerNames.get(token?.toLowerCase());
    if (index === undefined) throw new Error("无效寄存器「" + (token ?? "") + "」。");
    return index;
}

function requireArgs(name, args, count) {
    if (args.length !== count || args.some((arg) => !arg)) {
        throw new Error(name + " 需要 " + count + " 个操作数，操作数用逗号分隔。");
    }
}

function iWord(op, funct, rd, rs1, imm) {
    return ((imm & 0xfff) << 20) | (rs1 << 15) | (funct << 12) | (rd << 7) | op;
}

function offset(token, pc, labels, min, max) {
    const value = labels.has(token) ? labels.get(token) - pc : parseInteger(token);
    if (value % 4 !== 0) throw new Error("跳转目标必须按 4 字节对齐。");
    return bounded(value, min, max, "跳转偏移");
}

function address(arg) {
    const match = /^([^()]*)\(\s*([a-z0-9]+)\s*\)$/i.exec(arg);
    if (!match) throw new Error("地址格式示例：4(sp)。");
    return {
        base: reg(match[2]),
        imm: bounded(parseInteger(match[1].trim() || "0"), -2048, 2047, "访存偏移"),
    };
}

function literal(token) {
    return bounded(parseInteger(token), -0x80000000, 0xffffffff, "32 位整数") | 0;
}

function encode(name, args, pc, labels) {
    if (name === "li") {
        requireArgs(name, args, 2);
        const dest = reg(args[0]);
        const value = literal(args[1]);
        if (value >= -2048 && value <= 2047) return [iWord(0x13, 0, dest, 0, value)];
        const high = (value + 0x800) >> 12;
        const low = value - (high << 12);
        return [(high << 12) | (dest << 7) | 0x37, iWord(0x13, 0, dest, dest, low)];
    }
    if (name === "mv") {
        requireArgs(name, args, 2);
        return [iWord(0x13, 0, reg(args[0]), reg(args[1]), 0)];
    }
    if (name === "ret" || name === "nop" || name === "ebreak") {
        requireArgs(name, args, 0);
        if (name === "ret") return [iWord(0x67, 0, 0, 1, 0)];
        return [name === "nop" ? 0x13 : EBREAK];
    }
    if (Object.hasOwn(registers, name)) {
        requireArgs(name, args, 3);
        const [funct, funct7] = registers[name];
        return [(funct7 << 25) | (reg(args[2]) << 20) | (reg(args[1]) << 15) | (funct << 12) | (reg(args[0]) << 7) | 0x33];
    }
    if (Object.hasOwn(immediates, name) || Object.hasOwn(shifts, name)) {
        requireArgs(name, args, 3);
        const shift = Object.hasOwn(shifts, name);
        let value = parseInteger(args[2]);
        let funct;
        if (shift) {
            value = bounded(value, 0, 31, "移位量") | (shifts[name][1] << 5);
            funct = shifts[name][0];
        } else {
            value = bounded(value, -2048, 2047, "立即数");
            funct = immediates[name];
        }
        return [iWord(0x13, funct, reg(args[0]), reg(args[1]), value)];
    }
    if (Object.hasOwn(upper, name)) {
        requireArgs(name, args, 2);
        const value = bounded(parseInteger(args[1]), -0x80000, 0xfffff, "高位立即数");
        return [(value << 12) | (reg(args[0]) << 7) | upper[name]];
    }
    if (Object.hasOwn(branches, name)) {
        requireArgs(name, args, 3);
        const value = offset(args[2], pc, labels, -4096, 4094);
        return [((value & 0x1000) << 19) | ((value & 0x7e0) << 20) | (reg(args[1]) << 20) |
            (reg(args[0]) << 15) | (branches[name] << 12) | ((value & 0x1e) << 7) | ((value & 0x800) >> 4) | 0x63];
    }
    if (name === "jal" || name === "j") {
        const oneOperand = args.length === 1;
        requireArgs(name, args, name === "j" || oneOperand ? 1 : 2);
        const dest = name === "j" ? 0 : oneOperand ? 1 : reg(args[0]);
        const value = offset(args[oneOperand ? 0 : 1], pc, labels, -1048576, 1048574);
        return [((value & 0x100000) << 11) | ((value & 0x7fe) << 20) | ((value & 0x800) << 9) |
            (value & 0xff000) | (dest << 7) | 0x6f];
    }
    if (name === "jalr" && args.length === 3) {
        requireArgs(name, args, 3);
        return [iWord(0x67, 0, reg(args[0]), reg(args[1]), bounded(parseInteger(args[2]), -2048, 2047, "立即数"))];
    }
    if (name === "jalr" || Object.hasOwn(loads, name)) {
        requireArgs(name, args, 2);
        const { base, imm } = address(args[1]);
        return [iWord(name === "jalr" ? 0x67 : 3, name === "jalr" ? 0 : loads[name], reg(args[0]), base, imm)];
    }
    if (Object.hasOwn(stores, name)) {
        requireArgs(name, args, 2);
        const { base, imm } = address(args[1]);
        return [((imm & 0xfe0) << 20) | (reg(args[0]) << 20) | (base << 15) |
            (stores[name] << 12) | ((imm & 0x1f) << 7) | 0x23];
    }
    throw new Error("暂不支持指令「" + name + "」。");
}

export function assemble(source) {
    if (source.length > 24000) throw new Error("源码最多 24,000 字符。");
    const labels = new Map();
    const lines = [];
    let pc = 0;
    function lineError(index, error) {
        const problem = new Error("第 " + (index + 1) + " 行：" + error.message);
        problem.line = index;
        return problem;
    }
    source.split(/\r?\n/).forEach((raw, index) => {
        let statement = raw.split("#", 1)[0].trim();
        try {
            for (let match; (match = /^([A-Za-z_.][\w.]*)\s*:\s*/.exec(statement)); ) {
                if (labels.has(match[1])) throw new Error("标签「" + match[1] + "」重复定义。");
                labels.set(match[1], pc);
                statement = statement.slice(match[0].length);
            }
            if (!statement) return;
            const [name, ...operands] = statement.split(/\s+/);
            const args = operands.length ? operands.join(" ").split(",").map((arg) => arg.trim()) : [];
            const mnemonic = name.toLowerCase();
            let size = 4;
            if (mnemonic === "li") {
                requireArgs(name, args, 2);
                const value = literal(args[1]);
                if (value < -2048 || value > 2047) size = 8;
            }
            lines.push({ mnemonic, args, pc, index, source: statement });
            pc += size;
            if (pc > MAX_WORDS * 4) throw new Error("最多汇编 " + MAX_WORDS + " 条机器指令。");
        } catch (error) {
            throw lineError(index, error);
        }
    });
    if (!lines.length) throw new Error("请先输入一条指令。");
    const words = new Uint32Array(pc / 4);
    const instructions = [];
    for (const line of lines) {
        try {
            const encoded = encode(line.mnemonic, line.args, line.pc, labels);
            for (let index = 0; index < encoded.length; index++) {
                const at = line.pc / 4 + index;
                words[at] = encoded[index];
                instructions[at] = {
                    source: line.source,
                    line: line.index,
                    expansion: encoded.length === 1 ? "" : (index + 1) + "/" + encoded.length,
                };
            }
        } catch (error) {
            throw lineError(line.index, error);
        }
    }
    return { words, instructions };
}

function signed(bits, size) {
    return (bits << (32 - size)) >> (32 - size);
}

function branchTaken(funct, a, b) {
    switch (funct) {
        case 0: return a === b;
        case 1: return a !== b;
        case 4: return a < b;
        case 5: return a >= b;
        case 6: return (a >>> 0) < (b >>> 0);
        case 7: return (a >>> 0) >= (b >>> 0);
        default: throw new Error("未知条件分支。");
    }
}

function multiplyDivide(funct, a, b) {
    switch (funct) {
        case 0: return Math.imul(a, b);
        case 1: return Number((BigInt(a) * BigInt(b)) >> 32n);
        case 2: return Number((BigInt(a) * BigInt(b >>> 0)) >> 32n);
        case 3: return Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n);
        case 4: return b === 0 ? -1 : Math.trunc(a / b);
        case 5: return b === 0 ? -1 : Math.trunc((a >>> 0) / (b >>> 0));
        case 6: return b === 0 ? a : a % b;
        case 7: return b === 0 ? a : (a >>> 0) % (b >>> 0);
        default: throw new Error("未知乘除法指令。");
    }
}

function alu(funct, a, b, alternate) {
    switch (funct) {
        case 0: return alternate ? a - b : a + b;
        case 1: return a << (b & 31);
        case 2: return Number(a < b);
        case 3: return Number((a >>> 0) < (b >>> 0));
        case 4: return a ^ b;
        case 5: return alternate ? a >> (b & 31) : a >>> (b & 31);
        case 6: return a | b;
        case 7: return a & b;
        default: throw new Error("未知运算指令。");
    }
}

function dataOffset(address, width) {
    if (address < MEMORY_BASE || address + width > MEMORY_BASE + MEMORY_SIZE) {
        throw new Error("地址 " + toHex(address) + " 超出数据内存。");
    }
    if (address % width) throw new Error("地址 " + toHex(address) + " 没有按 " + width + " 字节对齐。");
    return address - MEMORY_BASE;
}

export function toHex(value, width = 8) {
    return "0x" + (value >>> 0).toString(16).padStart(width, "0");
}

export class Cpu {
    constructor(program) {
        this.program = program;
        this.registers = new Int32Array(32);
        this.memory = new DataView(new ArrayBuffer(MEMORY_SIZE));
        this.pc = 0;
        this.count = 0;
        this.halted = false;
        this.lastWrite = null;
    }

    current() {
        return this.program.instructions[this.pc / 4] ?? null;
    }

    step() {
        if (this.halted) return;
        if (this.pc % 4 || this.pc >= this.program.words.length * 4) {
            throw new Error("PC " + toHex(this.pc) + " 不在已汇编的指令区内。使用 ebreak 结束程序。");
        }
        const word = this.program.words[this.pc / 4];
        const op = word & 0x7f;
        const rd = (word >>> 7) & 31;
        const funct = (word >>> 12) & 7;
        const reg1 = (word >>> 15) & 31;
        const reg2 = (word >>> 20) & 31;
        const funct7 = word >>> 25;
        const a = this.registers[reg1];
        const b = this.registers[reg2];
        const imm = word >> 20;
        let destValue;
        let next = (this.pc + 4) >>> 0;
        this.lastWrite = null;

        if (word === EBREAK) {
            this.count++;
            this.halted = true;
            return;
        }
        switch (op) {
            case 0x33:
                destValue = funct7 === 1 ? multiplyDivide(funct, a, b) : alu(funct, a, b, funct7 === 32);
                break;
            case 0x13:
                destValue = alu(funct, a, imm, funct === 5 && funct7 === 32);
                break;
            case 0x37:
                destValue = word & 0xfffff000;
                break;
            case 0x17:
                destValue = this.pc + (word & 0xfffff000);
                break;
            case 0x63:
                if (branchTaken(funct, a, b)) {
                    const displacement = signed(((word >>> 31) << 12) | ((word & 0x80) << 4) |
                        ((word >>> 20) & 0x7e0) | ((word >>> 7) & 0x1e), 13);
                    next = (this.pc + displacement) >>> 0;
                }
                break;
            case 0x6f: {
                const displacement = signed(((word >>> 31) << 20) | (word & 0xff000) |
                    ((word >>> 9) & 0x800) | ((word >>> 20) & 0x7fe), 21);
                destValue = next;
                next = (this.pc + displacement) >>> 0;
                break;
            }
            case 0x67:
                destValue = next;
                next = ((a + imm) & ~1) >>> 0;
                break;
            case 3: {
                const width = 1 << (funct & 3);
                const location = dataOffset((a + imm) >>> 0, width);
                if (funct === 0) destValue = this.memory.getInt8(location);
                else if (funct === 4) destValue = this.memory.getUint8(location);
                else if (funct === 1) destValue = this.memory.getInt16(location, true);
                else if (funct === 5) destValue = this.memory.getUint16(location, true);
                else destValue = this.memory.getInt32(location, true);
                break;
            }
            case 0x23: {
                const width = 1 << funct;
                const displacement = (word >> 25 << 5) | ((word >>> 7) & 31);
                const address = (a + displacement) >>> 0;
                const location = dataOffset(address, width);
                if (width === 1) this.memory.setUint8(location, b);
                else if (width === 2) this.memory.setUint16(location, b, true);
                else this.memory.setUint32(location, b, true);
                this.lastWrite = { address, width };
                break;
            }
            default:
                throw new Error("无法执行机器码 " + toHex(word) + "。");
        }
        if (next % 4) throw new Error("跳转目标 " + toHex(next) + " 没有按 4 字节对齐。");
        if (rd && destValue !== undefined) this.registers[rd] = destValue;
        this.pc = next;
        this.count++;
    }
}
