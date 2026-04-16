class Potts {
  constructor(Lx, Ly, states, reducedTemperature, magneticField) {
    this.Q = states;
    this.TTC = reducedTemperature;
    this.H = magneticField;
    this.resize(Lx, Ly);
  }

  resize(Lx, Ly) {
    this.Lx = Lx;
    this.Ly = Ly;
    this.N = Lx * Ly;

    this.Spin = new Int8Array(this.N);
    this.NN0 = new Int32Array(this.N);
    this.NN1 = new Int32Array(this.N);
    this.NN2 = new Int32Array(this.N);
    this.NN3 = new Int32Array(this.N);

    this.Spin.forEach((_, index) => {
      this.Spin[index] = this.randomState(this.Q);
      const [x, y] = this.getCoordinate(index);
      this.NN0[index] = this.getIndex(x + 1, y);
      this.NN1[index] = this.getIndex(x, y + 1);
      this.NN2[index] = this.getIndex(x - 1, y);
      this.NN3[index] = this.getIndex(x, y - 1);
    });

    this.Parent = new Int32Array(this.N);
  }

  tc() {
    return 1 / Math.log(Math.sqrt(this.Q) + 1);
  }

  randomState(q) {
    return Math.floor(Math.random() * q) % q;
  }

  getCoordinate(index) {
    return [index % this.Lx, Math.floor(index / this.Lx)];
  }

  getIndex(x, y) {
    const wrappedX = (x + this.Lx) % this.Lx;
    const wrappedY = (y + this.Ly) % this.Ly;
    return wrappedX + wrappedY * this.Lx;
  }

  update() {
    this.heatBath();
  }

  heatBath() {
    const beta = 1 / (this.TTC * this.tc());
    const interactionWeight = Math.exp(beta);
    const fieldWeight = Math.exp(beta * this.H);

    for (let index = 0; index < this.N; index += 2) {
      this.singleFlip(index, interactionWeight, fieldWeight);
    }
    for (let index = 1; index < this.N; index += 2) {
      this.singleFlip(index, interactionWeight, fieldWeight);
    }
  }

  singleFlip(index, interactionWeight, fieldWeight) {
    const probabilities = new Float64Array(this.Q);
    probabilities.fill(1);
    probabilities[this.Spin[this.NN0[index]]] *= interactionWeight;
    probabilities[this.Spin[this.NN1[index]]] *= interactionWeight;
    probabilities[this.Spin[this.NN2[index]]] *= interactionWeight;
    probabilities[this.Spin[this.NN3[index]]] *= interactionWeight;
    probabilities[0] *= fieldWeight;

    const totalWeight = probabilities.reduce((sum, value) => sum + value, 0);
    const threshold = Math.random() * totalWeight;
    let cumulative = 0;

    for (let state = 0; state < this.Q; state += 1) {
      cumulative += probabilities[state];
      if (threshold < cumulative) {
        this.Spin[index] = state;
        break;
      }
    }
  }
}

class DrawPotts {
  constructor(id, useFullscreenCanvas) {
    this.id = id;
    this.useFullscreenCanvas = useFullscreenCanvas;
    this.cellSize = 4;
    this.minStates = 2;
    this.maxStates = 6;

    this.stage = new createjs.StageGL(this.id);
    if (this.useFullscreenCanvas) {
      this.stage.canvas.width = window.innerWidth;
      this.stage.canvas.height = window.innerHeight;
      this.stage.updateViewport(this.stage.canvas.width, this.stage.canvas.height);
    }

    this.stage.setClearColor("#ffffff");
    this.stage.update();

    const builder = new createjs.SpriteSheetBuilder();
    const rect = new createjs.Rectangle(0, 0, this.cellSize, this.cellSize);
    this.frameNumber = [];
    for (let states = this.minStates; states <= this.maxStates; states += 1) {
      this.frameNumber[states] = new Int32Array(states);
      for (let index = 0; index < states; index += 1) {
        this.frameNumber[states][index] = builder.addFrame(this.createCell(states, index), rect);
      }
    }
    this.spriteSheet = builder.build();

    const width = this.stage.canvas.width;
    const height = this.stage.canvas.height;
    const Lx = Math.floor(width / this.cellSize) + 1;
    const Ly = Math.floor(height / this.cellSize) + 1;

    this.potts = new Potts(Lx, Ly, 4, 1, 0);
    this.seedStageChildren();
    this.bindControls();

    createjs.Ticker.framerate = 20;
    createjs.Ticker.addEventListener("tick", () => this.update());

    if (this.useFullscreenCanvas) {
      this.timeoutID = 0;
      window.addEventListener("resize", () => {
        if (this.timeoutID) {
          return;
        }
        this.timeoutID = setTimeout(() => {
          this.timeoutID = 0;
          this.resize();
        }, 300);
      });
    }
  }

  seedStageChildren() {
    this.potts.Spin.forEach((state, index) => {
      const sprite = new createjs.Sprite(this.spriteSheet);
      sprite.gotoAndStop(this.frameNumber[this.potts.Q][state]);
      this.stage.addChild(sprite);
      const [x, y] = this.potts.getCoordinate(index);
      sprite.x = this.cellSize * x;
      sprite.y = this.cellSize * y;
    });
  }

  bindControls() {
    const stateSlider = document.getElementById("states");
    const stateText = document.getElementById("states_text");
    if (stateSlider && stateText) {
      const updateStates = (value) => {
        const states = Math.round(Number(value));
        this.potts.Q = states;
        stateText.textContent = String(states);
        stateSlider.value = String(states);
      };
      updateStates(this.potts.Q);
      stateSlider.addEventListener("input", (event) => updateStates(event.target.value));
    }

    const temperatureSlider = document.getElementById("temperature");
    const temperatureText = document.getElementById("temperature_text");
    if (temperatureSlider && temperatureText) {
      const updateTemperature = (value) => {
        const reducedTemperature = Number(value);
        this.potts.TTC = reducedTemperature;
        temperatureText.textContent = reducedTemperature === 1 ? "" : reducedTemperature.toFixed(2);
        temperatureSlider.value = String(reducedTemperature);
      };
      updateTemperature(this.potts.TTC);
      temperatureSlider.addEventListener("input", (event) => updateTemperature(event.target.value));
    }

    const fieldSlider = document.getElementById("field");
    const fieldText = document.getElementById("field_text");
    if (fieldSlider && fieldText) {
      const updateField = (value) => {
        const field = Number(value);
        this.potts.H = field;
        fieldText.textContent = field.toFixed(1);
        fieldSlider.value = String(field);
      };
      updateField(this.potts.H);
      fieldSlider.addEventListener("input", (event) => updateField(event.target.value));
    }
  }

  createCell(states, index) {
    const hue = (360 / states) * index;
    const shape = new createjs.Shape();
    shape.graphics
      .ss(0.5)
      .beginStroke("#ffffff")
      .beginFill(createjs.Graphics.getHSL(hue, 100, 72))
      .drawRect(0, 0, this.cellSize, this.cellSize);
    return shape;
  }

  draw() {
    this.potts.Spin.forEach((state, index) => {
      this.stage.children[index].gotoAndStop(this.frameNumber[this.potts.Q][state]);
    });
    this.stage.update();
  }

  update() {
    this.draw();
    this.potts.update();
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.stage.canvas.width = width;
    this.stage.canvas.height = height;
    this.stage.updateViewport(width, height);

    const Lx = Math.floor(width / this.cellSize) + 1;
    const Ly = Math.floor(height / this.cellSize) + 1;
    const N = Lx * Ly;

    for (let index = this.stage.numChildren; index < N; index += 1) {
      this.stage.addChildAt(new createjs.Sprite(this.spriteSheet), index);
    }
    for (let index = N; index < this.stage.numChildren; index += 1) {
      this.stage.children[index].visible = false;
    }

    this.potts.resize(Lx, Ly);
    this.potts.Spin.forEach((_, index) => {
      const [x, y] = this.potts.getCoordinate(index);
      this.stage.children[index].x = this.cellSize * x;
      this.stage.children[index].y = this.cellSize * y;
      this.stage.children[index].visible = true;
    });
  }
}

window.addEventListener("load", () => {
  new DrawPotts("potts", false);
});
