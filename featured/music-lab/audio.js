export class Synth {
    context;
    output;
    noise;
    voices = new Set();

    async unlock() {
        if (!this.context) {
            const Audio = window.AudioContext ?? window.webkitAudioContext;
            if (!Audio) throw new Error('此浏览器无法使用 Web Audio。');
            const context = this.context = new Audio({ latencyHint: 'interactive' });
            const output = this.output = context.createGain();
            const limiter = context.createDynamicsCompressor();
            output.gain.value = .72;
            limiter.threshold.value = -14;
            limiter.ratio.value = 5;
            output.connect(limiter).connect(context.destination);
            const length = Math.ceil(context.sampleRate * .25);
            this.noise = context.createBuffer(1, length, context.sampleRate);
            const samples = this.noise.getChannelData(0);
            for (let i = 0; i < length; i++) samples[i] = Math.random() * 2 - 1;
        }
        if (this.context.state !== 'running') await this.context.resume();
        if (this.context.state !== 'running') throw new Error('音频还未启动，请再点一次播放。');
        return this.context;
    }

    heardTime() {
        const context = this.context;
        const timestamp = context.getOutputTimestamp?.();
        if (timestamp?.performanceTime > 0) {
            return timestamp.contextTime + (performance.now() - timestamp.performanceTime) / 1000;
        }
        return context.currentTime - (context.outputLatency || context.baseLatency || 0);
    }

    play(track, pitches, at, stepTime, strength = 1) {
        const context = this.context;
        at = Math.max(at, context.currentTime);
        if (track === 3) {
            const oscillator = context.createOscillator();
            oscillator.frequency.setValueAtTime(135, at);
            oscillator.frequency.exponentialRampToValueAtTime(44, at + .125);
            this.voice(oscillator, oscillator, at, .22, .32 * strength, .004);
        } else if (track > 3) {
            const noise = context.createBufferSource();
            noise.buffer = this.noise;
            const filter = context.createBiquadFilter();
            filter.type = track === 4 ? 'bandpass' : 'highpass';
            filter.frequency.value = track === 4 ? 1300 : 7500;
            noise.connect(filter);
            this.voice(noise, filter, at, track === 4 ? .145 : .055, (track === 4 ? .22 : .095) * strength, .003);
        } else {
            for (const pitch of pitches) {
                const oscillator = context.createOscillator();
                oscillator.type = ['triangle', 'sine', 'triangle'][track];
                oscillator.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
                const length = stepTime * [1.55, 6.5, 2.8][track];
                const level = [.165, .13, .22][track] * strength / Math.sqrt(pitches.length);
                this.voice(oscillator, oscillator, at, length, level, track === 1 ? .036 : .008);
            }
        }
    }

    voice(source, node, at, duration, level, attack) {
        const gain = this.context.createGain();
        const end = at + duration;
        gain.gain.setValueAtTime(.0001, at);
        gain.gain.exponentialRampToValueAtTime(level, at + attack);
        gain.gain.exponentialRampToValueAtTime(.0001, end);
        node.connect(gain).connect(this.output);
        const voice = { source, node, gain };
        this.voices.add(voice);
        source.onended = () => {
            this.voices.delete(voice);
            source.disconnect();
            if (node !== source) node.disconnect();
            gain.disconnect();
        };
        source.start(at);
        source.stop(end + .015);
    }

    silence() {
        if (!this.context) return;
        const now = this.context.currentTime;
        for (const { source, gain } of this.voices) {
            gain.gain.cancelScheduledValues(now);
            gain.gain.setTargetAtTime(.0001, now, .005);
            source.stop(now + .02);
        }
    }
}
