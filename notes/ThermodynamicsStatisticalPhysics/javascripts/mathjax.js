window.MathJax = {
  loader: {
    load: ["[tex]/cancel", "[tex]/physics", "[tex]/mhchem", "[tex]/noerrors"]
  },
  tex: {
    packages: {"[+]": ["cancel", "physics", "mhchem", "noerrors"]},
    inlineMath: [["\\(", "\\)"]],
    displayMath: [["\\[", "\\]"]],
    processEscapes: true,
    processEnvironments: true
  },
  options: {
    skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"]
  }
};
