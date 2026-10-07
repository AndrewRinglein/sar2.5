// SAR1 AppSounds recipes, preserved from SAR v2/app.html.
// The facade supplies gesture-safe context and cancellable scheduling.
export const legacySounds = {
            audioContext: null,
            enabled: true,
            volume: 0.3, // Default volume 30%
            
            init() {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            },
            
            play(soundType) {
                if (!this.enabled || !this.audioContext) return;
                
                switch(soundType) {
                    case 'welcome':
                        this.playWelcomeChime();
                        break;
                    case 'click':
                        this.playSoftClick();
                        break;
                    case 'navigate':
                        this.playSwoosh();
                        break;
                    case 'refresh':
                        this.playDataSync();
                        break;
                    case 'success':
                        this.playSuccessDing();
                        break;
                    case 'event':
                        this.playCasinoChip();
                        break;
                    case 'shuffle':
                        this.playCardShuffle();
                        break;
                }
            },
            
            playCardShuffle() {
                // Create a realistic riffle shuffle sound with multiple layers
                try {
                    const now = this.audioContext.currentTime;
                    
                    // Layer 1: Rapid clicking sounds (cards hitting each other)
                    for (let i = 0; i < 12; i++) {
                        this.schedule(() => {
                            // Create click sound
                            const osc = this.audioContext.createOscillator();
                            const gain = this.audioContext.createGain();
                            const filter = this.audioContext.createBiquadFilter();
                            
                            // Bandpass filter for crisp click
                            filter.type = 'bandpass';
                            filter.frequency.value = 2000 + Math.random() * 1000;
                            filter.Q.value = 10;
                            
                            osc.type = 'square';
                            osc.frequency.value = 200 + Math.random() * 100;
                            
                            // Very short envelope for click
                            gain.gain.setValueAtTime(0, this.audioContext.currentTime);
                            gain.gain.linearRampToValueAtTime(this.volume * 0.05, this.audioContext.currentTime + 0.001);
                            gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 0.01);
                            
                            osc.connect(filter);
                            filter.connect(gain);
                            gain.connect(this.audioContext.destination);
                            
                            osc.start();
                            osc.stop(this.audioContext.currentTime + 0.01);
                        }, i * 15); // Rapid succession
                    }
                    
                    // Layer 2: Swoosh sounds (cards sliding)
                    for (let i = 0; i < 2; i++) {
                        this.schedule(() => {
                            const bufferSize = this.audioContext.sampleRate * 0.15;
                            const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
                            const output = buffer.getChannelData(0);
                            
                            // Generate filtered noise
                            for (let j = 0; j < bufferSize; j++) {
                                output[j] = (Math.random() * 2 - 1) * Math.exp(-j / bufferSize * 2);
                            }
                            
                            const noise = this.audioContext.createBufferSource();
                            noise.buffer = buffer;
                            
                            // Lowpass for swoosh
                            const filter = this.audioContext.createBiquadFilter();
                            filter.type = 'lowpass';
                            filter.frequency.value = 800 + (i * 300);
                            filter.Q.value = 1;
                            
                            const gain = this.audioContext.createGain();
                            gain.gain.setValueAtTime(0, this.audioContext.currentTime);
                            gain.gain.linearRampToValueAtTime(this.volume * 0.08, this.audioContext.currentTime + 0.03);
                            gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 0.15);
                            
                            noise.connect(filter);
                            filter.connect(gain);
                            gain.connect(this.audioContext.destination);
                            
                            noise.start();
                            noise.stop(this.audioContext.currentTime + 0.15);
                        }, 50 + (i * 100));
                    }
                    
                    // Layer 3: Flutter effect (cards settling)
                    this.schedule(() => {
                        const osc = this.audioContext.createOscillator();
                        const gain = this.audioContext.createGain();
                        const lfo = this.audioContext.createOscillator();
                        const lfoGain = this.audioContext.createGain();
                        
                        // LFO for flutter
                        lfo.frequency.value = 25;
                        lfoGain.gain.value = 50;
                        lfo.connect(lfoGain);
                        lfoGain.connect(osc.frequency);
                        
                        osc.type = 'triangle';
                        osc.frequency.value = 400;
                        
                        gain.gain.setValueAtTime(this.volume * 0.03, this.audioContext.currentTime);
                        gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 0.3);
                        
                        osc.connect(gain);
                        gain.connect(this.audioContext.destination);
                        
                        lfo.start();
                        osc.start();
                        lfo.stop(this.audioContext.currentTime + 0.3);
                        osc.stop(this.audioContext.currentTime + 0.3);
                    }, 180);
                    
                } catch (error) {
                    // Fall back if noise buffers are unavailable.
                    // Fallback simple beep
                    this.playSimpleBeep(400, 0.1);
                }
            },
            
            playSimpleBeep(frequency = 400, duration = 0.1) {
                const osc = this.audioContext.createOscillator();
                const gain = this.audioContext.createGain();
                osc.connect(gain);
                gain.connect(this.audioContext.destination);
                osc.type = 'sine';
                osc.frequency.value = frequency;
                gain.gain.value = this.volume * 0.3;
                gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);
                osc.start();
                osc.stop(this.audioContext.currentTime + duration);
            },
            
            playWelcomeChime() {
                // Three ascending notes with reverb-like delay
                const notes = [392, 523.25, 659.25]; // G4, C5, E5
                notes.forEach((freq, i) => {
                    this.schedule(() => {
                        const osc = this.audioContext.createOscillator();
                        const gain = this.audioContext.createGain();
                        osc.connect(gain);
                        gain.connect(this.audioContext.destination);
                        osc.type = 'sine';
                        osc.frequency.value = freq;
                        gain.gain.value = this.volume * (0.6 - i * 0.1);
                        gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.4);
                        osc.start();
                        osc.stop(this.audioContext.currentTime + 0.4);
                    }, i * 100);
                });
            },
            
            playSoftClick() {
                const osc = this.audioContext.createOscillator();
                const gain = this.audioContext.createGain();
                osc.connect(gain);
                gain.connect(this.audioContext.destination);
                osc.frequency.value = 800;
                gain.gain.value = this.volume * 0.2;
                gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.05);
                osc.start();
                osc.stop(this.audioContext.currentTime + 0.05);
            },
            
            playSwoosh() {
                const osc = this.audioContext.createOscillator();
                const gain = this.audioContext.createGain();
                const filter = this.audioContext.createBiquadFilter();
                filter.type = 'lowpass';
                filter.frequency.value = 1000;
                osc.connect(filter);
                filter.connect(gain);
                gain.connect(this.audioContext.destination);
                osc.type = 'sawtooth';
                osc.frequency.value = 200;
                osc.frequency.exponentialRampToValueAtTime(50, this.audioContext.currentTime + 0.1);
                filter.frequency.exponentialRampToValueAtTime(200, this.audioContext.currentTime + 0.1);
                gain.gain.value = this.volume * 0.15;
                gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
                osc.start();
                osc.stop(this.audioContext.currentTime + 0.1);
            },
            
            playDataSync() {
                // Quick ascending beeps
                for (let i = 0; i < 3; i++) {
                    this.schedule(() => {
                        const osc = this.audioContext.createOscillator();
                        const gain = this.audioContext.createGain();
                        osc.connect(gain);
                        gain.connect(this.audioContext.destination);
                        osc.type = 'square';
                        osc.frequency.value = 400 + (i * 200);
                        gain.gain.value = this.volume * 0.15;
                        gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.05);
                        osc.start();
                        osc.stop(this.audioContext.currentTime + 0.05);
                    }, i * 80);
                }
            },
            
            playSuccessDing() {
                const osc = this.audioContext.createOscillator();
                const gain = this.audioContext.createGain();
                osc.connect(gain);
                gain.connect(this.audioContext.destination);
                osc.frequency.value = 523.25; // C5
                osc.frequency.setValueAtTime(659.25, this.audioContext.currentTime + 0.05); // E5
                gain.gain.value = this.volume * 0.3;
                gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.15);
                osc.start();
                osc.stop(this.audioContext.currentTime + 0.15);
            },
            
            playCasinoChip() {
                // Two quick ticks
                for (let i = 0; i < 2; i++) {
                    this.schedule(() => {
                        const osc = this.audioContext.createOscillator();
                        const gain = this.audioContext.createGain();
                        osc.connect(gain);
                        gain.connect(this.audioContext.destination);
                        osc.frequency.value = 1000 + (i * 200);
                        gain.gain.value = this.volume * 0.25;
                        gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.03);
                        osc.start();
                        osc.stop(this.audioContext.currentTime + 0.03);
                    }, i * 30);
                }
            }
        };
