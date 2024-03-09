// navbar fixed
window.onscroll = function () {
  const header = document.querySelector("header");
  const fixednav = header.offsetTop;
  const backtop = document.querySelector("#backtop");

  if (window.pageYOffset > fixednav) {
    header.classList.add("navbar-fixed");
    backtop.classList.remove("hidden");
  } else {
    header.classList.remove("navbar-fixed");
    backtop.classList.add("hidden");
  }
};

// toggle system
const darktoggle = document.querySelector("#darktoggle");
const dtoggle = document.querySelector("#dtoggle");
const ltoggle = document.querySelector("#ltoggle");
const html = document.querySelector("html");
const backli = document.querySelector("#backiconlight");
const backda = document.querySelector("#backicondark");

darktoggle.addEventListener("click", function () {
  dtoggle.classList.toggle("hidden");
  ltoggle.classList.toggle("hidden");
  html.classList.toggle("dark");
  backli.classList.toggle("hidden");
  backda.classList.toggle("hidden");
});

// hamburger
const hamburger = document.querySelector("#hamburger");
const navmenu = document.querySelector("#nav-menu");

hamburger.addEventListener("click", function () {
  hamburger.classList.toggle("hamburger-active");
  navmenu.classList.toggle("hidden");
});

// click luar hamburger
window.addEventListener("click", function (e) {
  if (e.target != hamburger && e.target != navmenu) {
    hamburger.classList.remove("hamburger-active");
    navmenu.classList.add("hidden");
  }
});
