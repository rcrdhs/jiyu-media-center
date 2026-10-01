$(document).ready(function () {
    $("ul.listing li").live("mouseover", function () {
        $(this).addClass('click_hover');
    });
    $("ul.listing li").live("mouseout", function () {
        $(this).removeClass('click_hover');
    });

    $('.mask').click(function () {
        $('.login-popup').fadeOut();
        $('.mask').fadeOut();
    });


    $('.add_ads .add_ads_items_close').click(function () {
        $(this).parent().parent().fadeOut();
    });


    $('.menu_top li:not(.user)').each(function () {
        var href = $(this).find('a').attr('href');
        var current_url = window.location.protocol + '//' + window.location.hostname + window.location.pathname;
        if (current_url === href) {
            $('.menu_top li').removeClass('active');
            $(this).addClass('active');
        }
    });

    $('.menu_top2 li:not(.user)').each(function () {
        var href = $(this).find('a').attr('href');
        var current_url = window.location.protocol + '//' + window.location.hostname + window.location.pathname;
        if (current_url === href) {
            $('.menu_top2 li').removeClass('active');
            $(this).addClass('active');
        }
    });

    $('.menu_user .account').click(function (e) {
        $('.nav_down_up').toggle();
    });

    $('.fa-bars').click(function () {
        slideMenu = $('nav.menu_top');
        if (slideMenu.is(':hidden')) {
            $('#off_light').addClass('show');
            $(slideMenu).addClass('show');
            $('body').addClass('show');
        } else {
            $('#off_light').removeClass('show');
            $(slideMenu).removeClass('show');
            $('body').removeClass('show');
        }
    });

    $('#off_light').click(function () {
        $('#off_light').removeClass('show');
        $(slideMenu).removeClass('show');
        $('body').removeClass('show');
    });

    $('#view_more_episodes').click(function (e) {
        e.preventDefault();
        var id = (this).rel;
        var str = $(this).attr("str-alias");
        $('.drama_info_episodes_next').stop(true, true).load(base_url + '/load-episode.html?id=' + id + '&str=' + str);
        loadDing('load_episode');
    });

    $('.anime_muti_link li a').click(function (e) {
        e.preventDefault();

        var id = (this).rel;
        var link = $(this).attr('data-video');
        if ($(this).hasClass("active")) {
            return false;
        } else {
            $(".anime_video_body_watch_items.upload iframe").attr('src', link);
            $(".anime_video_body_watch_items.upload_estram").hide();
            $('html,body').animate({
                scrollTop: $(".anime_video_body_watch_items").offset().top
            }, 1000);
            setTimeout(function () {
                $(".anime_video_body_watch_items.bk").html('').hide();
            }, 1000);
        }
        $('.anime_muti_link li a').removeClass('active');
        $(this).addClass('active');
    });

    $('a.click_comment').click(function (e) {
        e.preventDefault();
        $(".share a").removeClass("active");
        $('html,body').animate({scrollTop: $('.comment').offset().top}, 1200);
    });
    $('a.click_info').click(function (e) {
        e.preventDefault();
        if ($(this).hasClass("active")) {
            $(this).removeClass("active");
        } else {
            $(this).addClass("active");
        }
        $("#load_info").toggle();

    });

});

function loadDing(str) {
    document.getElementById(str).innerHTML = "<img src='" + base_url + "/img/load/ajax-loader_1.gif' />";
}

function freload() {
    location.reload(true);
}