$(document).ready(function () {
  var id = -1;
  $("#search-form #keyword").keydown(function (e) {
    var keyword = $(this).val();
    if (e.keyCode === 13) {
      e.preventDefault();
      if (keyword !== "" || keyword.length > 2) {
        window.location.href = "/" + "search/?q=" + keyword;
      }
    }
    if ($("#header_search_autocomplete_body:visible").length > 0) {
      var items = $("#header_search_autocomplete_body").children();
      var nextElement = null;
      var current_index = -1;
      event_id = $("#key_pres").val();
      if (event_id !== "") {
        if (
          event_id.substring(0, "header_search_autocomplete_item_".length) ===
          "header_search_autocomplete_item_"
        ) {
          current_index = parseInt(
            event_id.replace("header_search_autocomplete_item_", "")
          );
          $("#header_search_autocomplete_body div").removeClass("focused");
        }
      }
      if (e.keyCode === 38) {
        e.preventDefault();
        current_index = Math.max(0, current_index - 1);
        nextElement = $("#header_search_autocomplete_item_" + current_index);
      } else if (e.keyCode === 40) {
        e.preventDefault();
        current_index = Math.min(items.length - 1, current_index + 1);
        nextElement = $("#header_search_autocomplete_item_" + current_index);
      }
      if (nextElement) {
        nextElement.stop(true, true);
        $("#header_search_autocomplete_item_" + current_index).focus();
        $("#header_search_autocomplete_item_" + current_index)
          .stop(true, true)
          .addClass("focused");
        $("#key_pres").val("header_search_autocomplete_item_" + current_index);
        var link_alias = $(
          "#header_search_autocomplete_item_" + current_index + " a"
        ).attr("rel");
        $("#link_alias").val(link_alias);
        $("#keyword_search_replace").val(keyword);
        id = current_index;
      }
    }
  });

  $(".mainsearchbox").keydown(function (e) {
    var keyword = $(this).val();
    if (e.keyCode === 13) {
      e.preventDefault();

      window.location.href = "/" + "search/?q=" + keyword;
    }
  });

  $(".search-submit").click(function () {
    var keyword = $(".mainsearchbox").val();

    if (keyword.length > 0) {
      window.location.href = "/" + "search/?q=" + keyword;
    }
  });
});
function createList(data){
  const listView = document.createElement('ul');
  for(let i=0; i<data.length; i++)
  {
    const listViewItem = document.createElement('li');
    const alist = document.createElement("a");
    const mode = data[i]['d'] === 'm'  ? "movie" : "series";
    alist.innerHTML = data[i]['t'];
    alist.href = '/' + mode + '/' + data[i]['s'] + '/';
    listViewItem.appendChild(alist);
    listView.appendChild(listViewItem);
  }

  return listView;
}
function preload(keyword, id) {
  if (keyword.length >= 2) {
    $.ajax({
      type: "get",
      url: "/searching",
      dataType: "json",
      data: { q: keyword, limit: 5, offset:0 },
      success: function (data, response) {
        $(".load.search").hide();
        $("#search-form #header_search_autocomplete").html(createList(data.data));
      },
    });
    $(".load.search").show();
    //$("#header_search_autocomplete .load").html(keyword);
  }
}
function do_search() {
  var keyword = $("#search-form.lap #keyword").val();
  keyword = keyword.replace(/\s+/g, "-");
  if (keyword.length >= 2) {
    window.location.href = base_url + "search/?q=" + keyword;
  } else {
    //$("#search-form #keyword").focus();
  }

  return false;
}

function do_search_Main() {
  console.log("Main search box");
  var keyword = $(".mainsearchbox").val();
  keyword = keyword.replace(/\s+/g, "-");
  if (keyword.length >= 2) {
    window.location.href = base_url + "search/?q=" + keyword;
  } else {
    //$("#search-form #keyword").focus();
  }

  return false;
}

function do_searchM() {
  var keyword = $("#search-form.mobi #keyword").val();
  keyword = keyword.replace(/\s+/g, "-");
  if (keyword.length >= 2) {
    window.location.href = base_url + "search/?q=" + keyword;
  } else {
    //$("#search-form #keyword").focus();
  }

  return false;
}
