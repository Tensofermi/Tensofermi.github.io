class Ising {
  constructor(Lx, Ly, temperature) {
    this.temperature = temperature;
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
      this.Spin[index] = Math.random() < 0.5 ? 1 : -1;
      const [x, y] = this.getCoordinate(index);
      this.NN0[index] = this.getIndex(x + 1, y);
      this.NN1[index] = this.getIndex(x, y + 1);
      this.NN2[index] = this.getIndex(x - 1, y);
      this.NN3[index] = this.getIndex(x, y - 1);
    });

    this.Parent = new Int32Array(this.N);
    this.Stack = [];
  }

  getCoordinate(index) {
    return [index % this.Lx, Math.floor(index / this.Lx)];
  }

  getIndex(x, y) {
    const wrappedX = (x + this.Lx) % this.Lx;
    const wrappedY = (y + this.Ly) % this.Ly;
    return wrappedX + wrappedY * this.Lx;
  }

  isUp(index) {
    return this.Spin[index] > 0;
  }

  update(algorithm) {
    if (algorithm === 1) {
      this.swendsenWang();
    } else if (algorithm === 2) {
      this.wolff();
    } else {
      this.heatBath();
    }
  }

  heatBath() {
    for (let index = 0; index < this.N; index += 2) {
      this.singleFlip(index);
    }
    for (let index = 1; index < this.N; index += 2) {
      this.singleFlip(index);
    }
  }

  singleFlip(index) {
    const spin = this.Spin[index];
    const neighborSum =
      this.Spin[this.NN0[index]] +
      this.Spin[this.NN1[index]] +
      this.Spin[this.NN2[index]] +
      this.Spin[this.NN3[index]];
    const flipProbability = 1 / (1 + Math.exp((2 * spin * neighborSum) / this.temperature));
    if (Math.random() < flipProbability) {
      this.Spin[index] *= -1;
    }
  }

  swendsenWang() {
    const bondProbability = 1 - Math.exp(-2 / this.temperature);
    this.Parent.forEach((_, index) => {
      this.Parent[index] = index;
    });
    this.Spin.forEach((_, index) => {
      this.connect(index, this.NN0[index], bondProbability);
      this.connect(index, this.NN1[index], bondProbability);
    });
    this.Spin.forEach((_, index) => {
      const root = this.find(index);
      if (index === root) {
        this.Spin[index] = Math.random() < 0.5 ? 1 : -1;
      } else {
        this.Spin[index] = this.Spin[root];
      }
    });
  }

  find(index) {
    let current = index;
    while (current !== this.Parent[current]) {
      [current, this.Parent[current]] = [this.Parent[current], this.Parent[this.Parent[current]]];
    }
    return current;
  }

  unite(a, b) {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) {
      return;
    }
    if (rootA > rootB) {
      [rootA, rootB] = [rootB, rootA];
    }
    this.Parent[rootB] = rootA;
  }

  connect(a, b, probability) {
    if (this.Spin[a] === this.Spin[b] && Math.random() < probability) {
      this.unite(a, b);
    }
  }

  wolff() {
    let count = 0;
    while (count < this.N / 5) {
      count += this.flipCluster();
    }
  }

  flipCluster() {
    const bondProbability = 1 - Math.exp(-2 / this.temperature);
    let index = Math.floor(Math.random() * this.N) % this.N;
    const clusterSpin = this.Spin[index];
    let count = 1;
    this.Spin[index] *= -1;
    this.Stack.push(index);

    while (this.Stack.length > 0) {
      index = this.Stack.pop();
      [this.NN0[index], this.NN1[index], this.NN2[index], this.NN3[index]].forEach((neighbor) => {
        if (clusterSpin === this.Spin[neighbor] && Math.random() < bondProbability) {
          count += 1;
          this.Spin[neighbor] *= -1;
          this.Stack.push(neighbor);
        }
      });
    }

    return count;
  }
}

class DrawIsing {
  constructor(id, useFullscreenCanvas) {
    this.id = id;
    this.useFullscreenCanvas = useFullscreenCanvas;
    this.algorithm = 0;
    this.framerates = [20, 5, 5];
    this.cellSize = 1;

    const backgroundColor = "#ffffff";
    const spinColor = "#c261f2";
    const cellShape = new createjs.Shape();
    cellShape.graphics
      .ss(0.5)
      .beginStroke(backgroundColor)
      .beginFill(spinColor)
      .drawRect(0, 0, this.cellSize, this.cellSize);
    cellShape.cache(0, 0, this.cellSize, this.cellSize);
    this.cellImage = cellShape.cacheCanvas;

    this.stage = new createjs.StageGL(this.id);
    if (this.useFullscreenCanvas) {
      this.stage.canvas.width = window.innerWidth;
      this.stage.canvas.height = window.innerHeight;
      this.stage.updateViewport(this.stage.canvas.width, this.stage.canvas.height);
    }

    this.stage.setClearColor(backgroundColor);
    this.stage.update();

    const width = this.stage.canvas.width;
    const height = this.stage.canvas.height;
    const Lx = Math.floor(width / this.cellSize) + 1;
    const Ly = Math.floor(height / this.cellSize) + 1;

    this.ising = new Ising(Lx, Ly, 2.27);
    this.seedStageChildren();
    this.bindControls();

    createjs.Ticker.framerate = this.framerates[this.algorithm];
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
    this.ising.Spin.forEach((_, index) => {
      const image = new createjs.Bitmap(this.cellImage);
      this.stage.addChild(image);
      const [x, y] = this.ising.getCoordinate(index);
      image.x = this.cellSize * x;
      image.y = this.cellSize * y;
    });
  }

  bindControls() {
    const temperatureSlider = document.getElementById("temperature");
    const temperatureText = document.getElementById("temperature_text");
    if (temperatureSlider && temperatureText) {
      const updateTemperature = (value) => {
        const numericValue = Number(value);
        this.ising.temperature = numericValue;
        temperatureText.textContent = numericValue.toFixed(2);
        temperatureSlider.value = String(numericValue);
      };
      updateTemperature(this.ising.temperature);
      temperatureSlider.addEventListener("input", (event) => updateTemperature(event.target.value));
    }

    const algorithmSelect = document.getElementById("algorithm");
    if (algorithmSelect) {
      algorithmSelect.value = String(this.algorithm);
      algorithmSelect.addEventListener("change", (event) => {
        this.changeAlgorithm(Number(event.target.value));
      });
    }
  }

  draw() {
    this.ising.Spin.forEach((_, index) => {
      this.stage.children[index].visible = this.ising.isUp(index);
    });
    this.stage.update();
  }

  update() {
    this.draw();
    this.ising.update(this.algorithm);
  }

  changeAlgorithm(algorithm) {
    this.algorithm = algorithm;
    createjs.Ticker.framerate = this.framerates[algorithm];
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
      this.stage.addChildAt(new createjs.Bitmap(this.cellImage), index);
    }
    this.stage.children.forEach((child) => {
      child.visible = false;
    });

    this.ising.resize(Lx, Ly);
    this.ising.Spin.forEach((_, index) => {
      const [x, y] = this.ising.getCoordinate(index);
      this.stage.children[index].x = this.cellSize * x;
      this.stage.children[index].y = this.cellSize * y;
    });
  }
}

window.addEventListener("load", () => {
  new DrawIsing("ising", false);
});
