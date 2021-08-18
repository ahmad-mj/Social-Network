export function messagesReducer(state = {}, action) {
    // console.log("action in slice: ", action);

    if (action.type == "GET/lastMessages") {
        state = {
            ...state,
            chatMessagesReceived: action.msgs,
        };
    }

    if (action.type == "GET/newMessage") {
        state = {
            ...state,
            chatMessagesReceived: [...state.chatMessagesReceived, action.msg],
        };
    }
    return state;
}

export function chatMessagesReceived(msgs) {
    return {
        type: "GET/lastMessages",
        msgs: msgs,
    };
}

export function chatMessageReceived(msg) {
    return {
        type: " GET/newMessage",
        msg: msg,
    };
}
