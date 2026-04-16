const model = (() => {
  const spinCount = 100;
  let temperature = 0.1;
  let gamma = 1.0;

  const spin = new Array(spinCount);
  const wall = new Array(spinCount);
  for (let index = 0; index < spinCount; index += 1) {
    spin[index] = Math.random() < 0.5 ? 1 : -1;
    wall[index] = initWall();
  }

  function exponentialDistance(theta) {
    if (theta > 0) {
      return Math.abs(Math.log(1 - Math.random()) * theta);
    }
    return Number.MAX_VALUE;
  }

  function makeWall() {
    const theta = temperature / gamma;
    let position = exponentialDistance(theta);
    const nextWall = [];
    while (position < 1) {
      nextWall.push(position);
      position += exponentialDistance(theta);
    }
    return nextWall;
  }

  function initWall() {
    const nextWall = makeWall();
    if (nextWall.length % 2 > 0) {
      nextWall.pop();
    }
    nextWall.push(1.0);
    return nextWall;
  }

  function createCluster(index) {
    const originalWall = wall[index];
    const randomWall = makeWall();
    randomWall.push(1.0);

    let position = 0;
    let originalIndex = 0;
    let randomIndex = 0;
    const mergedWall = [];
    while (position < 1) {
      const originalEdge = originalWall[originalIndex];
      const randomEdge = randomWall[randomIndex];
      if (originalEdge < randomEdge) {
        position = originalEdge;
        originalIndex += 1;
      } else {
        position = randomEdge;
        randomIndex += 1;
      }
      mergedWall.push(position);
    }

    return {
      num: mergedWall.length,
      wall: mergedWall,
      spin: new Array(mergedWall.length),
      ene: new Array(mergedWall.length).fill(0)
    };
  }

  function addEnergy(cluster, index) {
    const sourceWall = wall[index];
    let wallIndex = 0;
    let nextEdge = sourceWall[wallIndex++];
    let localSpin = spin[index];
    let bottom = 0;

    for (let clusterIndex = 0; clusterIndex < cluster.num; clusterIndex += 1) {
      const top = cluster.wall[clusterIndex];
      while (nextEdge < top) {
        cluster.ene[clusterIndex] += localSpin * (nextEdge - bottom);
        bottom = nextEdge;
        nextEdge = sourceWall[wallIndex++];
        localSpin *= -1;
      }
      cluster.ene[clusterIndex] += localSpin * (top - bottom);
      bottom = top;
    }
  }

  function probability(energy) {
    return 1 / (1 + Math.exp((-2 * energy) / temperature));
  }

  function flipCluster(cluster) {
    const edgeProbability = cluster.num === 1
      ? probability(cluster.ene[0])
      : probability(cluster.ene[0] + cluster.ene[cluster.num - 1]);
    cluster.spin[0] = Math.random() < edgeProbability ? 1 : -1;
    cluster.spin[cluster.num - 1] = cluster.spin[0];

    for (let index = 1; index < cluster.num - 1; index += 1) {
      cluster.spin[index] = Math.random() < probability(cluster.ene[index]) ? 1 : -1;
    }
  }

  function updateSpin(index) {
    const cluster = createCluster(index);
    addEnergy(cluster, (index + 1) % spinCount);
    addEnergy(cluster, (index - 1 + spinCount) % spinCount);
    flipCluster(cluster);

    spin[index] = cluster.spin[0];
    wall[index] = [];
    for (let position = 0; position < cluster.num - 1; position += 1) {
      if (cluster.spin[position] !== cluster.spin[position + 1]) {
        wall[index].push(cluster.wall[position]);
      }
    }
    wall[index].push(1.0);
  }

  function update() {
    for (let count = 0; count < spinCount; count += 1) {
      const index = Math.floor(Math.random() * spinCount);
      updateSpin(index);
    }
  }

  return {
    getSpinCount() {
      return spinCount;
    },
    getSpin(index) {
      return spin[index];
    },
    getWall(index) {
      return wall[index];
    },
    setTemperature(value) {
      temperature = value;
    },
    getTemperature() {
      return temperature;
    },
    setGamma(value) {
      gamma = value;
    },
    getGamma() {
      return gamma;
    },
    update
  };
})();

const view = (() => {
  const spinCount = model.getSpinCount();
  const cellWidth = 400 / spinCount - 1;
  const canvasHeight = 400;
  const colors = ["#c261f2", "#ffffff"];

  let running = false;
  let timerID = 0;
  let baseTime = 0;
  const interval = 50;

  const canvas = document.getElementById("model");
  const context = canvas.getContext("2d");
  canvas.width = spinCount * (cellWidth + 1) - 1;
  canvas.height = canvasHeight;

  function draw() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < spinCount; index += 1) {
      const localSpin = model.getSpin(index);
      const walls = model.getWall(index);
      context.fillStyle = localSpin > 0 ? colors[0] : colors[1];
      context.fillRect(index * (cellWidth + 1), 0, cellWidth, canvasHeight);

      context.fillStyle = localSpin > 0 ? colors[1] : colors[0];
      for (let wallIndex = 0; wallIndex < walls.length; wallIndex += 2) {
        const y0 = walls[wallIndex] * canvasHeight;
        const y1 = walls[wallIndex + 1] * canvasHeight;
        context.fillRect(index * (cellWidth + 1), y0, cellWidth, y1 - y0);
      }
    }
  }

  function update() {
    model.update();
    draw();
  }

  function loop() {
    const now = Date.now();
    if (now - baseTime > interval) {
      baseTime = now;
      update();
    }
    timerID = requestAnimationFrame(loop);
  }

  return {
    start() {
      if (!running) {
        loop();
      }
      running = true;
    },
    stop() {
      cancelAnimationFrame(timerID);
      running = false;
    },
    step() {
      this.stop();
      update();
    },
    draw
  };
})();

window.addEventListener("DOMContentLoaded", () => {
  const startButton = document.getElementById("start");
  const stopButton = document.getElementById("stop");
  const stepButton = document.getElementById("step");
  const temperatureSlider = document.getElementById("temp_slider");
  const temperatureValue = document.getElementById("temp_value");
  const gammaSlider = document.getElementById("gamma_slider");
  const gammaValue = document.getElementById("gamma_value");

  const setRunningState = (running) => {
    startButton.classList.toggle("is-primary", running);
    stopButton.classList.toggle("is-primary", !running);
    stepButton.classList.remove("is-primary");
  };

  const updateTemperature = (value) => {
    const temperature = Number(value);
    model.setTemperature(temperature);
    temperatureSlider.value = String(temperature);
    temperatureValue.textContent = temperature.toFixed(2);
  };

  const updateGamma = (value) => {
    const gamma = Number(value);
    model.setGamma(gamma);
    gammaSlider.value = String(gamma);
    gammaValue.textContent = gamma.toFixed(2);
  };

  startButton.addEventListener("click", () => {
    view.start();
    setRunningState(true);
  });

  stopButton.addEventListener("click", () => {
    view.stop();
    setRunningState(false);
  });

  stepButton.addEventListener("click", () => {
    view.step();
    setRunningState(false);
    stepButton.classList.add("is-primary");
    setTimeout(() => stepButton.classList.remove("is-primary"), 180);
  });

  temperatureSlider.addEventListener("input", (event) => {
    updateTemperature(event.target.value);
  });

  gammaSlider.addEventListener("input", (event) => {
    updateGamma(event.target.value);
  });

  updateTemperature(model.getTemperature());
  updateGamma(model.getGamma());
  view.draw();
  view.start();
  setRunningState(true);
});
